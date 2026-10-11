"""Arithmetic for bills. Prices include GST; everything is rounded to the paisa, half up.

Tax details are not yet confirmed by the clinic's accountant, so the rules live here in one place:

- A line's amount is quantity times rate.
- A discount comes off consultation lines first, then prescribed medicines, then products, in the
  order they appear. (A discount is usually given on the consultation, which carries no GST.)
- GST is worked back out of what is left on each rate, and split equally into CGST and SGST with
  any odd paisa on the CGST side.
"""

from decimal import ROUND_HALF_UP, Decimal

PAISA = Decimal("0.01")
ZERO = Decimal("0.00")
# Which lines sit under "Consultation and prescribed medicines"; the rest are "Products and supplements".
CARE_KINDS = ("service", "prescribed")
DISCOUNT_ORDER = {"service": 0, "prescribed": 1}


def paisa(value):
    return Decimal(value or 0).quantize(PAISA, rounding=ROUND_HALF_UP)


def line_amount(quantity, rate):
    return paisa(Decimal(quantity) * Decimal(rate))


def group_of(kind):
    return "care" if kind in CARE_KINDS else "products"


def totals(lines, discount=ZERO):
    """`lines` is a list of (kind, quantity, rate, gst_rate). Returns the figures a bill shows."""
    amounts = [line_amount(quantity, rate) for _, quantity, rate, _ in lines]
    subtotal = sum(amounts, ZERO)
    discount = min(max(paisa(discount), ZERO), subtotal)
    net, left = list(amounts), discount
    for index in sorted(range(len(lines)), key=lambda i: (DISCOUNT_ORDER.get(lines[i][0], 2), i)):
        taken = min(left, net[index])
        net[index] -= taken
        left -= taken
    by_rate = {}
    for (_, _, _, gst_rate), amount in zip(lines, net, strict=True):
        rate = Decimal(gst_rate or 0)
        if rate > 0 and amount > 0:
            by_rate[rate] = by_rate.get(rate, ZERO) + amount
    summary = []
    for rate in sorted(by_rate):
        gross = by_rate[rate]
        taxable = paisa(gross / (1 + rate / 100))
        tax = gross - taxable
        cgst = paisa(tax / 2)
        summary.append({"rate": rate, "taxable": taxable, "cgst": cgst, "sgst": tax - cgst, "tax": tax})
    return {
        "subtotal": subtotal,
        "discount": discount,
        "total": subtotal - discount,
        "tax_total": sum((row["tax"] for row in summary), ZERO),
        "tax_summary": summary,
    }


def financial_year(day):
    """26-27 for any day from 1 April 2026 to 31 March 2027."""
    start = day.year if day.month >= 4 else day.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"
