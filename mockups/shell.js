// Draws the shared frame (mockup strip, header, clinic tabs, patient banner) so each
// mockup page only holds its own content. Layout only; nothing here is application logic.
(function () {
  var body = document.body;
  var page = body.dataset.page || "";
  var tabs = [
    ["dashboard", "Dashboard", "dashboard.html"],
    ["patients", "Patients", "patients.html"],
    ["appointments", "Appointments", "appointments.html"],
    ["messages", "Messages <span class='count'>6</span>", "messages.html"],
    ["billing", "Billing", "billing.html"],
    ["library", "Library", "library.html"],
    ["printing", "Printing", "printing.html"],
    ["settings", "Settings", "settings.html"]
  ];
  var nav = tabs.map(function (t) {
    return "<a href='" + t[2] + "'" + (t[0] === page ? " class='active'" : "") + ">" + t[1] + "</a>";
  }).join("");
  var frame =
    "<div class='mock-bar'><a href='index.html'>&larr; All mockups</a><span>Static mockup. Nothing here saves, searches or prints real data. All names are invented.</span></div>";
  if (!body.hasAttribute("data-bare")) {
    frame +=
      "<header class='workspace-header'><a class='brand' href='dashboard.html'>DOCHP</a>" +
      "<div class='global-search'><input placeholder='Find a patient by name, phone or ID, or scan a card'><span class='kbd'>Ctrl K</span></div>" +
      "<div class='account'><span>Sunrise Clinic &#9662;</span><button class='secondary btn-sm'>Lock</button>" +
      "<span class='avatar'>RP</span><span>Dr. R. Patel &middot; Owner &#9662;</span></div></header>" +
      "<nav class='workspace-tabs'>" + nav + "</nav>";
  }
  body.insertAdjacentHTML("afterbegin", frame);

  var head = document.getElementById("patient-head");
  if (head) {
    var active = body.dataset.patientTab || "";
    var ptabs = [
      ["overview", "Overview", "patient-overview.html"], ["visits", "Visits", "visit.html"],
      ["rx", "Prescriptions", "#"], ["notes", "Notes", "#"], ["billing", "Billing", "invoice.html"],
      ["messages", "Messages", "#"], ["documents", "Documents", "#"]
    ];
    head.innerHTML =
      "<p><a href='patients.html'>&larr; Patient list</a></p>" +
      "<div class='patient-banner'><div class='photo'>AR</div><div><h1>Anita Rao</h1>" +
      "<p>Female &middot; 42 years &middot; +00 5550 0142 &middot; <span class='mono'>PAT-W8KQ3G7DP9</span></p>" +
      "<p class='small muted'>Last visit 06 Oct 2026 &middot; Follow-up due 20 Oct 2026 &middot; " +
      "<span class='badge b-amber'>Balance due 250.00</span> <span class='badge b-green'>WhatsApp consent: care</span></p></div>" +
      "<div class='spacer'></div><div class='actions'><a class='button' href='visit.html'>New visit</a>" +
      "<a class='button secondary' href='invoice.html'>New invoice</a><button class='secondary'>Message</button>" +
      "<button class='secondary'>More &#9662;</button></div></div>" +
      "<nav class='patient-tabs'>" + ptabs.map(function (t) {
        return "<a href='" + t[2] + "'" + (t[0] === active ? " class='active'" : "") + ">" + t[1] + "</a>";
      }).join("") + "</nav>";
  }
})();
