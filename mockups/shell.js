// Prototype frame: draws the header, tabs and patient banner, and makes the pages
// clickable (floating windows, menus, switches, notices, "view as" role).
// Nothing is saved or sent; this is not application code.
(function () {
  var body = document.body;
  var page = body.dataset.page || "";

  /* ---------- Role ("View as") ---------- */
  var ROLES = {
    owner: ["Owner", "Dr. R. Patel", "RP", ["dashboard", "patients", "appointments", "messages", "billing", "library", "printing", "settings"]],
    doctor: ["Doctor", "Dr. S. Sharma", "SS", ["dashboard", "patients", "appointments", "messages", "billing", "library", "printing"]],
    assistant: ["Clinical assistant", "Arun", "AR", ["dashboard", "patients", "appointments", "printing"]],
    reception: ["Reception", "Priya", "PR", ["dashboard", "patients", "appointments", "messages", "billing", "printing"]],
    billing: ["Billing", "Meena", "ME", ["dashboard", "patients", "billing", "printing"]],
    admin: ["Administrator", "Dev", "DE", ["dashboard", "printing", "settings"]]
  };
  var role = "owner";
  try { role = sessionStorage.getItem("protoRole") || "owner"; } catch (e) {}
  if (!ROLES[role]) role = "owner";
  var R = ROLES[role];
  body.dataset.role = role;
  var clinical = role === "owner" || role === "doctor" || role === "assistant";

  /* ---------- Frame ---------- */
  var tabs = [
    ["dashboard", "Dashboard", "dashboard.html"], ["patients", "Patients", "patients.html"],
    ["appointments", "Appointments", "appointments.html"],
    ["messages", "Messages <span class='count'>6</span>", "messages.html"],
    ["billing", "Billing", "billing.html"], ["library", "Library", "library.html"],
    ["printing", "Printing", "printing.html"], ["settings", "Settings", "settings.html"]
  ];
  var nav = tabs.filter(function (t) { return R[3].indexOf(t[0]) >= 0; }).map(function (t) {
    return "<a href='" + t[2] + "'" + (t[0] === page ? " class='active'" : "") + ">" + t[1] + "</a>";
  }).join("");
  var roleOptions = Object.keys(ROLES).map(function (k) {
    return "<option value='" + k + "'" + (k === role ? " selected" : "") + ">" + ROLES[k][0] + "</option>";
  }).join("");
  var ORDER = ["login", "dashboard", "patients", "patient-register", "patient-overview", "visit", "print-label", "invoice", "print-bill",
    "bill-new", "billing", "appointments", "messages", "library", "printing", "settings", "work-week", "overlays"];
  var here = ORDER.indexOf((location.pathname.split("/").pop() || "").replace(".html", ""));
  var prev = ORDER[(here + ORDER.length - 1) % ORDER.length] + ".html", next = ORDER[(here + 1) % ORDER.length] + ".html";
  var flip = here < 0 ? "" : "<a id='flip-prev' href='" + prev + "'>&lsaquo; Previous</a><span>" + (here + 1) + " of " + ORDER.length +
    "</span><a id='flip-next' href='" + next + "'>Next &rsaquo;</a>";
  var frame = "<div class='mock-bar'><a href='index.html'>All screens</a>" + flip +
    "<span>Prototype. Nothing is saved, sent or printed. All names are invented.</span><span class='spacer'></span>" +
    "<button class='link-button' data-menu='scanSim'>Simulate a scan &#9662;</button>" +
    "<label>View as <select id='proto-role'>" + roleOptions + "</select></label></div>";
  if (!body.hasAttribute("data-bare")) {
    frame += "<header class='workspace-header'><a class='brand' href='dashboard.html'>DOCHP</a>" +
      "<div class='global-search'><input id='global-search' placeholder='Find a patient by name, phone or ID, or scan a card' readonly><span class='kbd'>Ctrl K</span></div>" +
      "<div class='account'><span>Sunrise Clinic</span><a class='button secondary btn-sm' href='login.html'>Lock</a>" +
      "<button class='link-button account-btn' data-menu='account'><span class='avatar'>" + R[2] + "</span> " + R[1] + " &middot; " + R[0] + " &#9662;</button></div></header>" +
      "<nav class='workspace-tabs'>" + nav + "</nav>";
  }
  body.insertAdjacentHTML("afterbegin", frame);

  var head = document.getElementById("patient-head");
  if (head) {
    var active = body.dataset.patientTab || "";
    var ptabs = [
      ["overview", "Overview", "patient-overview.html", 0], ["visits", "Visits", "visit.html", 1],
      ["rx", "Prescriptions", "#", 1], ["notes", "Notes", "#", 0], ["billing", "Billing", "invoice.html", 0],
      ["messages", "Messages", "#", 0], ["documents", "Documents", "#", 1]
    ].filter(function (t) { return clinical || !t[3]; });
    head.innerHTML = "<p><a href='patients.html'>&larr; Patient list</a></p>" +
      "<div class='patient-banner'><div class='photo'>AR</div><div><h1>Anita Rao</h1>" +
      "<p>Female &middot; 42 years &middot; +91 90000 00142 &middot; <span class='mono'>PAT-W8KQ3G7DP9</span></p>" +
      "<p class='small muted'>Last visit 06 Oct 2026 &middot; Next advised 20 Oct 2026 &middot; " +
      "<span class='badge b-amber'>Balance due &#8377;320</span> <span class='badge b-green'>WhatsApp consent: care</span></p></div>" +
      "<div class='spacer'></div><div class='actions'>" +
      (clinical ? "<a class='button' href='visit.html'>New visit</a>" : "") +
      "<a class='button secondary' href='invoice.html'>New invoice</a><button class='secondary'>Message</button>" +
      "<button class='secondary' data-menu='patientMore'>More &#9662;</button></div></div>" +
      "<nav class='patient-tabs'>" + ptabs.map(function (t) {
        return "<a href='" + t[2] + "'" + (t[0] === active ? " class='active'" : "") + ">" + t[1] + "</a>";
      }).join("") + "</nav>";
  }

  /* ---------- Floating windows (also shown as specimens on overlays.html) ---------- */
  var X = "<span class='x' data-close>&#10005;</span>";
  var DIALOGS = {
    finder: "<div class='dialog wide'><div class='body'><input value='rao' style='font-size: 1.1rem'></div>" +
      "<div class='menu' style='border: 0; box-shadow: none; border-top: 1px solid var(--border); border-radius: 0'>" +
      "<div class='hd'>Patients</div>" +
      "<a class='hover' href='patient-overview.html'><span><strong>Anita Rao</strong> &middot; 42 F &middot; &hellip;00142</span><span class='kbd'>Enter</span></a>" +
      "<a href='patient-overview.html'><span><strong>Vikram Rao</strong> &middot; 47 M &middot; &hellip;00143</span></a>" +
      "<a href='patient-overview.html'><span><strong>Sunita Rao-Mehta</strong> &middot; 8 F &middot; &hellip;00142</span></a>" +
      "<div class='sep'></div><div class='hd'>Actions</div>" +
      "<a href='patient-register.html'><span>Register &ldquo;rao&rdquo; as a new patient</span></a>" +
      "<a href='patients.html'><span>See all results</span></a></div></div>",
    productScan: "<div class='dialog'><header>Product scanned " + X + "</header><div class='body'>" +
      "<p style='font-size: 1.05rem'><strong>Vitamin D3 capsules, 60</strong> &middot; &#8377;450.00</p>" +
      "<p class='muted' style='margin: 0'>A visit for <strong>Anita Rao</strong> is open. Who is this for?</p></div>" +
      "<footer><a class='button secondary' href='bill-new.html'>New bill for someone else</a><button data-add-product='Vitamin D3 capsules, 60|450'>Add to Anita Rao&rsquo;s visit</button></footer></div>",
    scanUnknown: "<div class='dialog'><header>Barcode not recognised " + X + "</header><div class='body'>" +
      "<p>This code is not a patient ID or a product in the price list. Nothing was opened.</p>" +
      "<p class='muted small' style='margin: 0'>A replaced patient card shows &ldquo;This card is no longer valid&rdquo; here instead.</p></div>" +
      "<footer><button class='secondary' data-close>Close</button><button>Add as a new product</button></footer></div>",
    payment: "<div class='dialog'><header>Record payment &middot; INV/26-27/1042 " + X + "</header><div class='body'>" +
      "<p>Anita Rao &middot; balance due <strong>&#8377;320.00</strong></p><div class='form-grid two'>" +
      "<label>Amount (&#8377;) <input value='320.00'></label><label>Date <input value='06 Oct 2026'></label>" +
      "<label class='span-all'>Method <span class='segmented'><span class='on'>Cash</span><span>UPI</span><span>Card</span><span>Bank transfer</span></span></label>" +
      "<label class='span-all'>Reference <input placeholder='UPI or card reference, optional'></label></div>" +
      "<label class='check' style='margin-top: 10px'><input type='checkbox' checked> Print receipt</label>" +
      "<label class='check'><input type='checkbox'> Send receipt on WhatsApp</label></div>" +
      "<footer><button class='secondary' data-close>Cancel</button><button data-toast='Payment of &#8377;320.00 recorded. Invoice is now Paid.'>Save payment</button></footer></div>",
    label: "<div class='dialog wide'><header>Print envelope labels " + X + "</header><div class='body'>" +
      "<table class='small'><tr><th></th><th>Envelope</th><th>Printed on the label</th><th>Copies</th></tr>" +
      "<tr><td><input type='checkbox' checked></td><td>Envelope 1</td><td>4 tabs, twice daily, before meals, 14 days</td><td><input value='1' style='width: 50px'></td></tr>" +
      "<tr><td><input type='checkbox' checked></td><td>Envelope 2</td><td>1 powder at bedtime, once a week, 2 weeks</td><td><input value='1' style='width: 50px'></td></tr></table>" +
      "<p class='info small'>Medicine names are never printed. Each label carries the clinic logo and address, patient name, dosage, patient barcode, today&rsquo;s date and the next advised date (20 Oct 2026).</p>" +
      "<div class='form-grid two'><label>Printer <select><option>Label printer, dispensary (2 &times; 2 in)</option></select></label>" +
      "<label>&nbsp;<a href='print-label.html'>Preview the label</a></label></div></div>" +
      "<footer><button class='secondary' data-close>Skip</button><button data-toast='2 labels sent to the label printer.'>Print 2 labels</button></footer></div>",
    book: "<div class='dialog xl'><header>New appointment " + X + "</header><div class='body'>" +
      "<label>Phone number <input value='90000 00142' inputmode='numeric' style='font-size: 1.15rem; letter-spacing: .04em'></label>" +
      "<div class='picks'><div class='pick sel'><span><strong>Anita Rao</strong> &middot; 42 F</span><span class='mono muted'>PAT-W8KQ3G7DP9</span></div>" +
      "<div class='pick'><span><strong>Sunita Rao-Mehta</strong> &middot; 8 F</span><span class='mono muted'>PAT-J9Q2W5XD7A</span></div>" +
      "<div class='pick'><span><strong>+ New patient</strong> with this number</span><span class='muted small'>asks only for a name now</span></div></div>" +
      "<div class='cols cols-even' style='margin-top: 14px; gap: 18px'><div>" +
      "<div class='heading' style='margin-bottom: 8px'><button class='secondary btn-sm'>&lsaquo;</button><strong>October 2026</strong><button class='secondary btn-sm'>&rsaquo;</button></div>" +
      "<div class='cal' data-cal='2026-10' data-sel='20' data-today='6' data-past='5' data-sundays-off></div>" +
      "<p class='small muted' style='margin: 8px 0 0'>Greyed days are closed in the work week.</p></div>" +
      "<div><span class='segmented' style='margin-bottom: 10px'><span class='on'>Follow-up &middot; 15 min</span><span>First visit &middot; 45 min</span></span>" +
      "<div class='small muted'>Morning</div><div class='slots'><span class='slot-chip taken'>9:30</span><span class='slot-chip'>9:45</span><span class='slot-chip'>10:00</span><span class='slot-chip sel'>10:15</span><span class='slot-chip'>10:30</span><span class='slot-chip taken'>10:45</span><span class='slot-chip'>11:00</span><span class='slot-chip'>11:15</span><span class='slot-chip'>11:30</span><span class='slot-chip'>12:00</span><span class='slot-chip'>12:30</span>" +
      "<div class='small muted' style='margin-top: 4px'>Evening</div><span class='slot-chip'>5:00</span><span class='slot-chip'>5:15</span><span class='slot-chip taken'>5:30</span><span class='slot-chip'>6:00</span><span class='slot-chip'>6:30</span><span class='slot-chip'>7:00</span><span class='slot-chip'>7:30</span></div>" +
      "<label style='margin-top: 6px'>Doctor <select><option>Dr. R. Patel</option><option>Dr. S. Sharma</option></select></label></div></div>" +
      "<div class='info' style='margin-bottom: 0'><strong id='bk-sum'>Anita Rao &middot; Tue 20 Oct 2026 &middot; 10:15</strong><br>" +
      "<label class='check' style='margin-top: 4px'><input type='checkbox' checked> Send a WhatsApp reminder the day before</label></div></div>" +
      "<footer><button class='secondary' data-close>Cancel</button><button data-toast='Appointment booked.'>Book appointment</button></footer></div>",
    finalise: "<div class='dialog'><header>Finalise this visit?</header><div class='body'>After this the visit cannot be edited. Corrections are added as amendments.<br><br>" +
      "<label class='check'><input type='checkbox'> Do not ask again today</label></div>" +
      "<footer><button class='secondary' data-close>Back</button><button data-toast='Visit finalised.' data-next='label'>Finalise</button></footer></div>",
    leave: "<div class='dialog'><header>Leave without saving?</header><div class='body'>The visit for Anita Rao has changes that are not saved.</div>" +
      "<footer><button class='secondary' data-close>Keep editing</button><button class='secondary' data-toast='Draft saved.'>Save draft and leave</button><button class='danger' data-close>Discard changes</button></footer></div>",
    message: "<div class='dialog'><header>WhatsApp message to Anita Rao " + X + "</header><div class='body'>" +
      "<label>Template <select><option>Appointment reminder</option><option>Follow-up check-in</option><option>Invoice and receipt</option><option>Write my own</option></select></label>" +
      "<textarea rows='5' style='margin-top: 10px'>Hello Anita, this is a reminder of your appointment at Sunrise Clinic on 20 Oct 2026 at 10:15.</textarea>" +
      "<p class='small muted' style='margin: 8px 0 0'>Insert: <span class='chip'>first name</span> <span class='chip'>doctor</span> <span class='chip'>appointment time</span> <span class='chip'>clinic name</span><br>Messages never contain a diagnosis, symptoms or medicine names.</p></div>" +
      "<footer><button class='danger' data-close>Discard</button><button class='secondary' data-toast='Draft saved.'>Save draft</button><button data-toast='Message queued for sending.'>Approve and send</button></footer></div>",
    product: "<div class='dialog'><header>Add a product to the bill " + X + "</header><div class='body'>" +
      "<input placeholder='Search products, supplements and consumables' value='cal'>" +
      "<div class='menu' style='box-shadow: none; margin-top: 8px'>" +
      "<div class='hover' data-add-product='Calendula cream 30 g|120'><span>Calendula cream 30 g</span><span>&#8377;120.00</span></div>" +
      "<div data-add-product='Calcium tablets, 60|280'><span>Calcium tablets, 60</span><span>&#8377;280.00</span></div>" +
      "<div data-add-product='Vitamin D3 capsules, 60|450'><span>Vitamin D3 capsules, 60</span><span>&#8377;450.00</span></div>" +
      "<div data-add-product='Sugar-of-milk globules, 25 g|60'><span>Sugar-of-milk globules, 25 g</span><span>&#8377;60.00</span></div></div>" +
      "<p class='small muted' style='margin: 8px 0 0'>Products come from the price list. A barcode scan on the pack adds it directly.</p></div>" +
      "<footer><button class='secondary' data-close>Close</button></footer></div>"
  };
  var MENUS = {
    account: "<div class='hd'>" + R[1] + " &middot; " + R[0] + "</div><div>My account</div><div>Change password</div><div><span>Keyboard shortcuts</span><span class='kbd'>?</span></div><div class='sep'></div><a href='login.html'><span>Lock</span><span class='kbd'>Ctrl L</span></a><a href='login.html'>Sign out</a>",
    scanSim: "<div class='hd'>Pretend the scanner read&hellip;</div><div data-scan='PAT-W8KQ3G7DP9'>A patient card, bill or envelope label</div><div data-scan='8901234567890'>A product pack (Vitamin D3)</div><div data-scan='0000000'>A barcode nobody knows</div><div class='sep'></div><div class='hd'>A real barcode scanner works on these pages too</div>",
    patientMore: "<a href='patient-register.html'>Edit details</a><div data-open='book'>Book appointment</div><div>Print patient card</div><div>Replace lost card</div><div>Message consent&hellip;</div><div>Change history</div><div class='sep'></div><div style='color: #853124'>Archive patient</div>"
  };
  window.PROTO = { dialogs: DIALOGS, menus: MENUS };

  // overlays.html shows the same windows as specimens
  document.querySelectorAll("[data-dialog]").forEach(function (el) { el.innerHTML = DIALOGS[el.dataset.dialog] || ""; });
  document.querySelectorAll("[data-menu-specimen]").forEach(function (el) { el.innerHTML = "<div class='menu'>" + MENUS[el.dataset.menuSpecimen] + "</div>"; });

  /* ---------- Calendars ---------- */
  function calHTML(y, m, o) {
    o = o || {};
    var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7, days = new Date(y, m, 0).getDate(), h = "";
    ["M", "T", "W", "T", "F", "S", "S"].forEach(function (d) { h += "<span class='dow'>" + d + "</span>"; });
    for (var i = 0; i < lead; i++) h += "<span></span>";
    for (var d = 1; d <= days; d++) {
      var sunday = new Date(y, m - 1, d).getDay() === 0;
      var off = (o.sundaysOff && sunday) || (o.past && d <= o.past) || (o.off && o.off.indexOf(d) >= 0);
      h += "<span class='cal-day" + (off ? " off" : "") + (d === o.sel ? " sel" : "") + (d === o.today ? " today" : "") + "' data-d='" + d + "'>" + d +
        (o.label ? "<small>" + o.label(d, off) + "</small>" : "") + "</span>";
    }
    return h;
  }
  function fillCals(scope) {
    scope.querySelectorAll("[data-cal]").forEach(function (c) {
      var p = c.dataset.cal.split("-");
      c.innerHTML = calHTML(+p[0], +p[1], { sel: +c.dataset.sel || 0, today: +c.dataset.today || 0, past: +c.dataset.past || 0, sundaysOff: c.hasAttribute("data-sundays-off") });
    });
  }
  window.PROTO.cal = calHTML;
  fillCals(document);

  /* ---------- Barcode scan routing ---------- */
  var PRODUCTS = { "8901234567890": ["Vitamin D3 capsules, 60", 450], "8901234567891": ["Calendula cream 30 g", 120] };
  function flash(text) { try { sessionStorage.setItem("protoFlash", text); } catch (e) {} }
  function addProduct(name, rate) {
    var draft = document.getElementById("draft"), visit = document.getElementById("visit-products");
    if (draft) {
      var tr = document.createElement("tr");
      tr.className = "line";
      tr.innerHTML = "<td>" + name + "</td><td><input class='num q' value='1'></td><td><input class='num r' value='" + rate + "'></td><td>18%</td><td class='num a'></td><td class='x'>&#10005;</td>";
      document.getElementById("add-row").before(tr);
      recalc();
    } else if (visit) {
      visit.insertAdjacentHTML("beforeend", "<div class='row'><span>" + name + "<span class='muted'>Scanned just now</span></span><span>&times; 1 &middot; &#8377;" + rate + "</span></div>");
    }
    toast(name + " added.");
  }
  function scan(code) {
    closeAll();
    var product = PRODUCTS[code];
    if (/^PAT-/.test(code)) {
      // A patient ID always opens that patient's profile.
      flash("Scanned " + code + ". Opened Anita Rao.");
      location.href = "patient-overview.html";
    } else if (product) {
      if (body.hasAttribute("data-visit-active")) openDialog("productScan");      // visit open: ask who it is for
      else if (document.getElementById("draft")) addProduct(product[0], product[1]);  // a bill is already open: add to it
      else { flash(product[0] + " scanned. New bill started."); location.href = "bill-new.html"; }
    } else openDialog("scanUnknown");
  }
  window.PROTO.scan = scan;
  try { var fl = sessionStorage.getItem("protoFlash"); if (fl) { sessionStorage.removeItem("protoFlash"); setTimeout(function () { toast(fl); }, 150); } } catch (e) {}

  /* ---------- Draft bill arithmetic ---------- */
  function money(n) { return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function recalc() {
    var draft = document.getElementById("draft"), total = document.getElementById("total"), disc = document.getElementById("disc"), sum = 0;
    if (!draft) return;
    draft.querySelectorAll("tr.line").forEach(function (r) {
      var a = (parseFloat(r.querySelector(".q").value) || 0) * (parseFloat(r.querySelector(".r").value) || 0);
      r.querySelector(".a").textContent = money(a); sum += a;
    });
    if (total) total.value = money(Math.max(0, sum - (disc ? parseFloat(disc.value) || 0 : 0)));
    document.querySelectorAll("[data-total]").forEach(function (n) { n.textContent = money(sum); });
  }
  document.addEventListener("input", function (e) { if (e.target.closest("#draft") || e.target.id === "disc") recalc(); });
  recalc();

  function bookingSummary(dlg) {
    var out = dlg.querySelector("#bk-sum"), who = dlg.querySelector(".pick.sel strong"), day = dlg.querySelector(".cal-day.sel"), time = dlg.querySelector(".slot-chip.sel");
    if (!out || !day) return;
    var d = new Date(2026, 9, +day.dataset.d);
    out.textContent = (who ? who.textContent.replace("+ ", "") : "") + " \u00b7 " + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + day.dataset.d + " Oct 2026" + (time ? " \u00b7 " + time.textContent : "");
  }

  function closeAll() { document.querySelectorAll(".modal-backdrop, .pop-menu").forEach(function (n) { n.remove(); }); }
  function openDialog(id) {
    if (!DIALOGS[id]) return;
    closeAll();
    var b = document.createElement("div");
    b.className = "modal-backdrop";
    b.innerHTML = DIALOGS[id];
    body.appendChild(b);
    fillCals(b);
    var f = b.querySelector("input:not([type=checkbox])");
    if (f) f.focus();
  }
  function openMenu(id, anchor) {
    closeAll();
    var m = document.createElement("div"), r = anchor.getBoundingClientRect();
    m.className = "menu pop-menu";
    m.innerHTML = MENUS[id];
    body.appendChild(m);
    m.style.top = (r.bottom + window.scrollY + 4) + "px";
    m.style.left = Math.max(8, r.right + window.scrollX - m.offsetWidth) + "px";
  }
  function toast(text) {
    var host = document.getElementById("toast-host");
    if (!host) { host = document.createElement("div"); host.id = "toast-host"; body.appendChild(host); }
    var t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = text;
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }
  window.PROTO.toast = toast;
  window.PROTO.open = openDialog;

  // What a button does, by its wording. Anything not listed says so in a notice.
  var OPENS = [["Record payment", "payment"], ["New appointment", "book"], ["Book appointment", "book"], ["Book", "book"], ["Reschedule", "book"],
    ["Finalise visit", "finalise"], ["Print envelope label", "label"], ["Label", "label"], ["Dispense", "label"],
    ["Message", "message"], ["New message", "message"], ["Edit", "message", "messages"], ["Add product", "product"], ["+ Add product", "product"], ["Discard draft", "leave"]];
  var TOASTS = [["Save draft", "Draft saved."], ["Mark arrived", "Marked as arrived."], ["Approve and send", "Message approved and queued for sending."],
    ["Approve selected", "1 message approved."], ["Save changes", "Saved."], ["Issue", "Invoice issued as INV/26-27/1043."],
    ["Issue and take payment", "Invoice issued as INV/26-27/1043."], ["Print test label", "Test label sent to the label printer."],
    ["Retry", "Sent to the printer again."], ["Reprint", "Sent to the printer again."], ["Search", "Showing matches."]];

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest("#toast-host")) return;
    var inMenu = t.closest(".pop-menu");
    var backdrop = t.closest(".modal-backdrop");
    if (t.classList.contains("modal-backdrop") || t.closest("[data-close]")) { closeAll(); return; }

    var sw = t.closest(".toggle");
    if (sw) { sw.classList.toggle("on"); return; }
    var seg = t.closest(".segmented > span");
    if (seg) { seg.parentNode.querySelectorAll("span").forEach(function (s) { s.classList.remove("on"); }); seg.classList.add("on"); seg.dispatchEvent(new Event("change", { bubbles: true })); return; }
    var chip = t.closest(".chip");
    if (chip && !chip.closest(".dialog")) {
      var group = chip.parentNode.querySelectorAll(".chip");
      if (chip.textContent.indexOf("✕") >= 0) { chip.remove(); return; }
      if (chip.closest(".toolbar")) group.forEach(function (c) { c.classList.remove("on"); });
      chip.classList.toggle("on"); return;
    }
    var sub = t.closest(".sub-tabs a, .side-nav a");
    if (sub && sub.getAttribute("href") === "#") { e.preventDefault(); sub.parentNode.querySelectorAll("a").forEach(function (a) { a.classList.remove("active"); }); sub.classList.add("active"); if (!sub.dataset.show) toast("&ldquo;" + sub.textContent.trim() + "&rdquo; is listed in the UI list but not drawn yet."); return; }

    var sc = t.closest("[data-scan]");
    if (sc) { scan(sc.dataset.scan); return; }
    var day = t.closest(".cal-day");
    if (day) {
      var cal = day.parentNode;
      if (cal.classList.contains("multi")) { day.classList.toggle("off"); cal.dispatchEvent(new CustomEvent("calchange", { detail: day })); return; }
      if (day.classList.contains("off")) return;
      cal.querySelectorAll(".sel").forEach(function (n) { n.classList.remove("sel"); }); day.classList.add("sel");
      if (backdrop) bookingSummary(backdrop); return;
    }
    var slot = t.closest(".slot-chip, .pick");
    if (slot) {
      if (slot.classList.contains("taken")) return;
      slot.parentNode.querySelectorAll(".sel").forEach(function (n) { n.classList.remove("sel"); }); slot.classList.add("sel");
      if (backdrop) bookingSummary(backdrop); return;
    }
    if (t.classList.contains("x") && t.closest("#draft")) { t.closest("tr").remove(); recalc(); return; }

    var menuBtn = t.closest("[data-menu]");
    if (menuBtn) { e.preventDefault(); openMenu(menuBtn.dataset.menu, menuBtn); return; }
    var opener = t.closest("[data-open]");
    if (opener) { e.preventDefault(); openDialog(opener.dataset.open); return; }

    var el = t.closest("button, a, .menu > div");
    if (!el) { if (!inMenu && !backdrop) closeAll(); return; }
    if (el.dataset.addProduct) { var pd = el.dataset.addProduct.split("|"); closeAll(); addProduct(pd[0], pd[1]); return; }
    if (el.hasAttribute("onclick") || el.classList.contains("hd") || el.classList.contains("sep")) return;
    if (el.dataset.toast) { var next = el.dataset.next; closeAll(); toast(el.dataset.toast); if (next) openDialog(next); return; }
    if (el.tagName === "A" && el.getAttribute("href") !== "#") return;
    e.preventDefault();
    var label = el.textContent.replace(/[▾▸›‹→]/g, "").trim(), i;
    if (label === "Scan card") { scan("PAT-W8KQ3G7DP9"); return; }
    for (i = 0; i < OPENS.length; i++) if (OPENS[i][0] === label && (!OPENS[i][2] || OPENS[i][2] === page)) { openDialog(OPENS[i][1]); return; }
    for (i = 0; i < TOASTS.length; i++) if (TOASTS[i][0] === label) { closeAll(); toast(TOASTS[i][1]); return; }
    if (backdrop || inMenu) closeAll();
    if (label) toast("&ldquo;" + label + "&rdquo; is not wired up in the prototype yet.");
  });

  // A barcode scanner types very fast and ends with Enter; that is how a scan is told apart from a person typing.
  var scanBuf = "", scanAt = 0;
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll();
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName);
    var now = Date.now();
    if (!typing && e.key.length === 1) { if (now - scanAt > 60) scanBuf = ""; scanBuf += e.key; scanAt = now; }
    else if (!typing && e.key === "Enter" && scanBuf.length >= 6 && now - scanAt < 60) { e.preventDefault(); var code = scanBuf; scanBuf = ""; scan(code); return; }
    if (here >= 0 && !typing && !e.ctrlKey && !e.altKey && !e.metaKey && !document.querySelector(".modal-backdrop")) {
      if (e.key === "ArrowRight") location.href = next;
      if (e.key === "ArrowLeft") location.href = prev;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openDialog("finder"); }
  });
  var gs = document.getElementById("global-search");
  if (gs) gs.addEventListener("focus", function () { gs.blur(); openDialog("finder"); });
  document.getElementById("proto-role").addEventListener("change", function () {
    try { sessionStorage.setItem("protoRole", this.value); } catch (e) {}
    location.reload();
  });
})();
