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
  var frame = "<div class='mock-bar'><a href='index.html'>&larr; All screens</a>" +
    "<span>Prototype. Nothing is saved, sent or printed. All names are invented.</span><span class='spacer'></span>" +
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
    scan: "<div class='dialog'><header>Card scanned " + X + "</header><div class='body'>" +
      "<div class='patient-banner' style='padding: 0'><div class='photo'>AR</div><div><strong>Anita Rao</strong><p class='muted'>42 F &middot; PAT-W8KQ3G7DP9 &middot; appointment today 09:30</p></div></div>" +
      "<p class='small muted' style='margin: 10px 0 0'>The same window opens when an envelope label is scanned. A replaced card shows &ldquo;This card is no longer valid&rdquo;.</p></div>" +
      "<footer><button class='secondary' data-toast='Marked as arrived'>Mark arrived</button><a class='button' href='patient-overview.html'>Open record</a></footer></div>",
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
    book: "<div class='dialog'><header>Book appointment " + X + "</header><div class='body'><div class='form-grid two'>" +
      "<label class='span-all'>Patient <input value='Anita Rao &middot; PAT-W8KQ3G7DP9'></label>" +
      "<label>Date <input value='20 Oct 2026'></label><label>Time <select><option>10:15</option><option>10:30</option><option>11:15</option></select></label>" +
      "<label>Doctor <select><option>Dr. R. Patel</option><option>Dr. S. Sharma</option></select></label>" +
      "<label>Type <select><option>Follow-up (15 min)</option><option>First consultation (45 min)</option></select></label>" +
      "<label class='span-all'>Note for reception <input placeholder='Optional'></label></div>" +
      "<label class='check' style='margin-top: 10px'><input type='checkbox' checked> Send a WhatsApp reminder the day before</label></div>" +
      "<footer><button class='secondary' data-close>Cancel</button><button data-toast='Appointment booked for 20 Oct 2026, 10:15.'>Book</button></footer></div>",
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
    patientMore: "<a href='patient-register.html'>Edit details</a><div data-open='book'>Book appointment</div><div>Print patient card</div><div>Replace lost card</div><div>Message consent&hellip;</div><div>Change history</div><div class='sep'></div><div style='color: #853124'>Archive patient</div>"
  };
  window.PROTO = { dialogs: DIALOGS, menus: MENUS };

  // overlays.html shows the same windows as specimens
  document.querySelectorAll("[data-dialog]").forEach(function (el) { el.innerHTML = DIALOGS[el.dataset.dialog] || ""; });
  document.querySelectorAll("[data-menu-specimen]").forEach(function (el) { el.innerHTML = "<div class='menu'>" + MENUS[el.dataset.menuSpecimen] + "</div>"; });

  function closeAll() { document.querySelectorAll(".modal-backdrop, .pop-menu").forEach(function (n) { n.remove(); }); }
  function openDialog(id) {
    if (!DIALOGS[id]) return;
    closeAll();
    var b = document.createElement("div");
    b.className = "modal-backdrop";
    b.innerHTML = DIALOGS[id];
    body.appendChild(b);
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
    ["Finalise visit", "finalise"], ["Print envelope label", "label"], ["Label", "label"], ["Dispense", "label"], ["Scan card", "scan"],
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

    var menuBtn = t.closest("[data-menu]");
    if (menuBtn) { e.preventDefault(); openMenu(menuBtn.dataset.menu, menuBtn); return; }
    var opener = t.closest("[data-open]");
    if (opener) { e.preventDefault(); openDialog(opener.dataset.open); return; }

    var el = t.closest("button, a, .menu > div");
    if (!el) { if (!inMenu && !backdrop) closeAll(); return; }
    if (el.dataset.addProduct) { var pd = el.dataset.addProduct.split("|"); closeAll(); if (window.PROTO.onAddProduct) window.PROTO.onAddProduct(pd[0], pd[1]); toast(pd[0] + " added."); return; }
    if (el.hasAttribute("onclick") || el.classList.contains("hd") || el.classList.contains("sep")) return;
    if (el.dataset.toast) { var next = el.dataset.next; closeAll(); toast(el.dataset.toast); if (next) openDialog(next); return; }
    if (el.tagName === "A" && el.getAttribute("href") !== "#") return;
    e.preventDefault();
    var label = el.textContent.replace(/[▾▸›‹→]/g, "").trim(), i;
    for (i = 0; i < OPENS.length; i++) if (OPENS[i][0] === label && (!OPENS[i][2] || OPENS[i][2] === page)) { openDialog(OPENS[i][1]); return; }
    for (i = 0; i < TOASTS.length; i++) if (TOASTS[i][0] === label) { closeAll(); toast(TOASTS[i][1]); return; }
    if (backdrop || inMenu) closeAll();
    if (label) toast("&ldquo;" + label + "&rdquo; is not wired up in the prototype yet.");
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openDialog("finder"); }
  });
  var gs = document.getElementById("global-search");
  if (gs) gs.addEventListener("focus", function () { gs.blur(); openDialog("finder"); });
  document.getElementById("proto-role").addEventListener("change", function () {
    try { sessionStorage.setItem("protoRole", this.value); } catch (e) {}
    location.reload();
  });
})();
