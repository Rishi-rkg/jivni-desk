// The four small animated samples on the home page. Each scene is a piece
// of markup and a script for the pointer; a scene only plays while it is
// on screen, and with reduced motion it shows its finished state instead.
(function () {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = '<div class="cursor"><svg viewBox="0 0 26 26"><path d="M3 2.5l17.5 8.2-7.4 2.3-2.6 7.6z" fill="#fff" stroke="#10323c" stroke-width="1.6" stroke-linejoin="round"/></svg></div>';
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  function mount(id, markup, play) {
    const root = document.getElementById(id);
    if (!root) return;
    root.innerHTML = `<div class="bit-float"><div class="bit-frame"><div class="bit-stage">${markup}${pointer}</div></div></div>`;
    const stage = root.querySelector(".bit-stage");
    const cursor = root.querySelector(".cursor");
    new ResizeObserver(() => root.style.setProperty("--s", (root.clientWidth / 560).toFixed(4))).observe(root);

    let visible = false;
    new IntersectionObserver(([entry]) => (visible = entry.isIntersecting), { threshold: 0.25 }).observe(root);
    const tools = {
      $: (selector) => stage.querySelector(selector),
      $$: (selector) => [...stage.querySelectorAll(selector)],
      async wait(ms) {
        await sleep(ms);
        while (!visible || document.hidden) await sleep(300);
      },
      // Position inside the unscaled stage; screen rectangles are skewed by the tilt.
      async moveTo(el, fx = 0.5, fy = 0.55) {
        let x = el.offsetWidth * fx;
        let y = el.offsetHeight * fy;
        for (let node = el; node && node !== stage; node = node.offsetParent) {
          x += node.offsetLeft;
          y += node.offsetTop;
        }
        cursor.style.transform = `translate3d(${x}px, ${y}px, 30px)`;
        await tools.wait(820);
      },
      async press(el) {
        cursor.classList.add("down");
        if (el) {
          el.classList.remove("pressed");
          void el.offsetWidth;
          el.classList.add("pressed");
        }
        await tools.wait(150);
      },
      async release() {
        cursor.classList.remove("down");
        await tools.wait(170);
      },
      async click(el, fx, fy) {
        await tools.moveTo(el, fx, fy);
        await tools.press(el);
        await tools.release();
      },
      async type(el, text) {
        el.classList.add("focus");
        for (const letter of text) {
          el.textContent += letter;
          await tools.wait(70);
        }
        el.classList.remove("focus");
      },
    };
    if (still) {
      play(tools, true);
      return;
    }
    (async () => {
      for (;;) await play(tools, false);
    })();
  }

  const bars = '<div class="bars"></div>';
  const row = (initials, name, code, note) => `<div class="s-row"><i>${initials}</i><span><b>${name}</b><small>${code}</small></span><em>${note}</em></div>`;

  // ----- Patients: register someone new and hand them a card -----
  mount(
    "bit-patients",
    `<div class="bit-win">
      <div class="s-bar"><b>Patients</b><span class="s-search">Search by name, phone or scan</span><span class="s-btn" data-new>New patient</span></div>
      <div class="s-list">
        ${row("AS", "Anita Sharma", "PAT-W8KQ3G7DP9", "Follow-up due 20 Oct")}
        ${row("SS", "Sunita Sharma", "PAT-9KD4T2WM6H", "Seen today")}
        ${row("RK", "Ravi Kulkarni", "PAT-4HX2M9QT7C", "Follow-up due 14 Oct")}
        ${row("MD", "Meera Desai", "PAT-T7B3N8RV2K", "Last seen 28 Sep")}
        ${row("JF", "Joseph Fernandes", "PAT-Q2L6X5YD8P", "Last seen 12 Sep")}
      </div>
      <div class="s-sheet">
        <b>New patient</b>
        <label>Name<span class="s-input" data-name></span></label>
        <label>Phone<span class="s-input" data-phone></span></label>
        <div class="s-ok">No similar patient on record</div>
        <div><span class="s-btn" data-save>Register</span></div>
      </div>
    </div>
    <div class="s-pop s-card paper"><b>Imran Qureshi</b>Mehta Homeopathy Clinic${bars}PAT-M3V8K1ZC5R</div>`,
    async (t, done) => {
      const sheet = t.$(".s-sheet");
      const name = t.$("[data-name]");
      const phone = t.$("[data-phone]");
      const card = t.$(".s-card");
      const add = () => t.$(".s-list").insertAdjacentHTML("afterbegin", row("IQ", "Imran Qureshi", "PAT-M3V8K1ZC5R", "Registered just now").replace("s-row", "s-row new"));
      t.$$(".s-row.new").forEach((el) => el.remove());
      name.textContent = phone.textContent = "";
      sheet.classList.remove("open");
      card.classList.remove("out");
      t.$(".s-ok").classList.remove("show");
      if (done) {
        add();
        card.classList.add("out");
        return;
      }
      await t.wait(1200);
      await t.click(t.$("[data-new]"));
      sheet.classList.add("open");
      await t.wait(500);
      await t.click(name, 0.3);
      await t.type(name, "Imran Qureshi");
      await t.click(phone, 0.3);
      await t.type(phone, "98200 14302");
      t.$(".s-ok").classList.add("show");
      await t.wait(500);
      await t.click(t.$("[data-save]"));
      sheet.classList.remove("open");
      await t.wait(250);
      add();
      await t.wait(700);
      card.classList.add("out");
      await t.moveTo(t.$(".s-list"), 0.45, 0.8);
      await t.wait(3600);
    },
  );

  // ----- Calendar: book from a phone number, then drag to another day -----
  const appt = (c, r, name, kind, tone = "") => `<div class="appt ${tone}" style="--c:${c};--r:${r}" data-who="${name}">${name}<small>${kind}</small></div>`;
  mount(
    "bit-calendar",
    `<div class="bit-win">
      <div class="s-bar"><b>Appointments</b><span class="s-dim">12 to 17 October</span><span class="grow"></span><span class="s-btn ghost">Week</span></div>
      <div class="cal">
        <div class="cal-days"><span></span><b>Mon 12</b><span>Tue 13</span><span>Wed 14</span><span>Thu 15</span><span>Fri 16</span><span>Sat 17</span></div>
        <div class="cal-times"><span>9:00</span><span>10:00</span><span>11:00</span><span>12:00</span><span>5:00</span></div>
        <div class="cal-grid">
          ${appt(0, 0, "Anita S.", "Follow-up")}
          ${appt(0, 2, "Joseph F.", "First visit", "amber")}
          ${appt(1, 1, "Sunita S.", "Medicine only", "green")}
          ${appt(2, 0, "Ravi K.", "Follow-up")}
          ${appt(3, 2, "Kavita R.", "First visit", "amber")}
          ${appt(4, 1, "Meera D.", "Follow-up")}
          <div class="appt fresh green" style="--c:1;--r:3">New<small>12:00</small></div>
          <div class="slot" data-slot="new" style="--c:1;--r:3"></div>
          <div class="slot" data-slot="drop" style="--c:5;--r:2"></div>
        </div>
        <div class="cal-pop">
          <label style="display: grid; gap: 3px; font-weight: 600">Phone number<span class="s-input" data-phone></span></label>
          <div class="cal-match"><b>Imran Qureshi</b><span class="s-dim">on record</span></div>
        </div>
      </div>
    </div>`,
    async (t, done) => {
      const fresh = t.$(".appt.fresh");
      const pop = t.$(".cal-pop");
      const phone = t.$("[data-phone]");
      const match = t.$(".cal-match");
      const meera = t.$('[data-who="Meera D."]');
      const book = () => {
        fresh.innerHTML = "Imran Q.<small>Follow-up</small>";
        fresh.classList.add("show");
      };
      fresh.classList.remove("show");
      fresh.innerHTML = "New<small>12:00</small>";
      pop.classList.remove("open");
      match.classList.remove("show");
      phone.textContent = "";
      meera.style.setProperty("--c", 4);
      meera.style.setProperty("--r", 1);
      if (done) {
        book();
        meera.style.setProperty("--c", 5);
        meera.style.setProperty("--r", 2);
        return;
      }
      await t.wait(1200);
      await t.click(t.$('[data-slot="new"]'));
      fresh.classList.add("show");
      await t.wait(300);
      pop.classList.add("open");
      await t.wait(450);
      await t.click(phone, 0.3);
      await t.type(phone, "98200 14302");
      match.classList.add("show");
      await t.wait(450);
      await t.click(match, 0.4);
      pop.classList.remove("open");
      book();
      await t.wait(900);
      // Drag Meera's appointment from Friday to Saturday.
      await t.moveTo(meera);
      await t.press();
      meera.classList.add("held");
      await t.wait(200);
      meera.style.setProperty("--c", 5);
      meera.style.setProperty("--r", 2);
      await t.moveTo(t.$('[data-slot="drop"]'));
      meera.classList.remove("held");
      await t.release();
      await t.wait(3600);
    },
  );

  // ----- WhatsApp: approve a drafted reminder and watch it arrive -----
  mount(
    "bit-whatsapp",
    `<div class="bit-win">
      <div class="s-bar"><b>Messages</b><span class="s-dim">2 waiting for your approval</span></div>
      <div class="wa">
        <div class="wa-queue">
          <div class="wa-item"><b>Anita Sharma</b><p>Reminder: appointment tomorrow at 3:00 PM</p><div class="row"><span class="s-btn ghost">Edit</span><span class="s-btn" data-approve>Approve</span></div></div>
          <div class="wa-item"><b>Ravi Kulkarni</b><p>30-day check-in: how are you feeling?</p><div class="row"><span class="s-btn ghost">Edit</span><span class="s-btn" data-approve>Approve</span></div></div>
        </div>
        <div class="wa-phone">
          <div class="wa-top"><i>AS</i><div>Anita Sharma<small>WhatsApp</small></div></div>
          <div class="wa-chat">
            <div class="bubble mine">Namaste Anita, this is a reminder of your appointment tomorrow at 3:00 PM.<br>Mehta Homeopathy Clinic<time>10:02 <span class="ticks2">✓✓</span></time></div>
            <div class="bubble typing"><b></b><b></b><b></b></div>
            <div class="bubble" data-reply>Thank you doctor, I will be there.<time>10:05</time></div>
          </div>
        </div>
      </div>
    </div>`,
    async (t, done) => {
      const buttons = t.$$("[data-approve]");
      const items = t.$$(".wa-item");
      const out = t.$(".bubble.mine");
      const typing = t.$(".typing");
      const reply = t.$("[data-reply]");
      const ticks = t.$(".ticks2");
      const sent = (i) => {
        buttons[i].textContent = "Sent";
        buttons[i].classList.add("done");
        items[i].classList.add("sent");
      };
      buttons.forEach((b) => ((b.textContent = "Approve"), b.classList.remove("done")));
      items.forEach((i) => i.classList.remove("sent"));
      [out, typing, reply].forEach((b) => b.classList.remove("show"));
      ticks.classList.remove("read");
      if (done) {
        sent(0);
        out.classList.add("show");
        reply.classList.add("show");
        ticks.classList.add("read");
        return;
      }
      await t.wait(1200);
      await t.click(buttons[0]);
      sent(0);
      await t.wait(350);
      out.classList.add("show");
      await t.wait(1100);
      ticks.classList.add("read");
      await t.wait(500);
      typing.classList.add("show");
      await t.wait(1400);
      typing.classList.remove("show");
      reply.classList.add("show");
      await t.wait(900);
      await t.click(buttons[1]);
      sent(1);
      await t.wait(3400);
    },
  );

  // ----- Bills: scan two products, print -----
  mount(
    "bit-bills",
    `<div class="bit-win">
      <div class="s-bar"><b>New bill</b><span class="s-dim">Anita Sharma</span><span class="grow"></span><span class="scan-chip">Scan a pack to add it</span></div>
      <div class="bill">
        <div class="bill-line"><span>Consultation</span><span>₹300</span></div>
        <div class="bill-line"><span>Medicines<small>prescribed today</small></span><span>₹250</span></div>
        <div class="bill-line added"><span>Calendula cream 30 g<small>× 1</small></span><span>₹120</span></div>
        <div class="bill-line added"><span>Vitamin D3 drops<small>× 1</small></span><span>₹180</span></div>
        <div class="bill-total"><span>Total</span><span data-total>₹550</span></div>
        <div class="bill-foot"><span class="s-btn" data-print>Print bill</span><span class="s-btn ghost">UPI</span><span class="s-btn ghost">Cash</span></div>
      </div>
      <div class="scan-beam"></div>
    </div>
    <div class="s-pop s-receipt paper">
      <b>Mehta Homeopathy Clinic</b><br>Anita Sharma, 06 Oct 2026
      <div style="margin-top: 5px"><span>Consultation</span><span>300</span></div>
      <div><span>Medicines</span><span>250</span></div>
      <div><span>Calendula cream 30 g</span><span>120</span></div>
      <div><span>Vitamin D3 drops</span><span>180</span></div>
      <div class="sum"><span>Total</span><span>₹850</span></div>
      ${bars}PAT-W8KQ3G7DP9
    </div>`,
    async (t, done) => {
      const added = t.$$(".bill-line.added");
      const chip = t.$(".scan-chip");
      const beam = t.$(".scan-beam");
      const total = t.$("[data-total]");
      const totalRow = t.$(".bill-total");
      const receipt = t.$(".s-receipt");
      const print = t.$("[data-print]");
      added.forEach((line) => line.classList.remove("show"));
      chip.textContent = "Scan a pack to add it";
      chip.classList.remove("hit");
      total.textContent = "₹550";
      receipt.classList.remove("out");
      print.textContent = "Print bill";
      print.classList.remove("done");
      if (done) {
        added.forEach((line) => line.classList.add("show"));
        total.textContent = "₹850";
        receipt.classList.add("out");
        return;
      }
      const scan = async (line, from, to) => {
        beam.classList.remove("sweep");
        chip.classList.remove("hit");
        void beam.offsetWidth;
        beam.classList.add("sweep");
        chip.textContent = "Scanned";
        chip.classList.add("hit");
        await t.wait(350);
        line.classList.add("show");
        for (let step = 1; step <= 8; step++) {
          total.textContent = "₹" + Math.round(from + ((to - from) * step) / 8);
          await sleep(35);
        }
        totalRow.classList.remove("bump");
        void totalRow.offsetWidth;
        totalRow.classList.add("bump");
      };
      await t.wait(1300);
      await scan(added[0], 550, 670);
      await t.wait(1100);
      await scan(added[1], 670, 850);
      await t.wait(900);
      await t.click(print);
      print.textContent = "Printed";
      print.classList.add("done");
      await t.wait(250);
      receipt.classList.add("out");
      await t.moveTo(t.$(".bill"), 0.35, 0.5);
      await t.wait(3800);
    },
  );
})();
