// Drives the app sample in the hero: a scripted pointer finds a patient,
// sets the dosage and prints the envelope label, then starts again.
(function () {
  const demo = document.getElementById("demo");
  if (!demo) return;
  const $ = (sel) => demo.querySelector(sel);
  const stage = $(".demo-stage");
  const tilt = $(".demo-tilt");
  const cursor = $(".cursor");
  const search = $(".app-search");
  const typed = $(".typed");
  const results = $(".results");
  const today = $(".v-today");
  const visit = $(".v-visit");
  const tabs = demo.querySelectorAll(".app-tabs span");
  const preview = $(".preview");
  const doseMain = $("#dose-main");
  const doseSub = $("#dose-sub");
  const finish = $(".finish");
  const label = $(".demo-label");
  const toast = $(".demo-toast");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Fit the 860px drawing to whatever width the column gives it.
  new ResizeObserver(() => {
    demo.style.setProperty("--s", (demo.clientWidth / 860).toFixed(4));
  }).observe(demo);

  // Lean a little toward the pointer, on top of the slow float.
  if (!still) {
    addEventListener("pointermove", (e) => {
      const x = e.clientX / innerWidth - 0.5;
      const y = e.clientY / innerHeight - 0.5;
      tilt.style.setProperty("--ry", (x * 9).toFixed(2) + "deg");
      tilt.style.setProperty("--rx", (-y * 7).toFixed(2) + "deg");
    });
  }

  let visible = true;
  new IntersectionObserver(([entry]) => (visible = entry.isIntersecting)).observe(demo);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  async function wait(ms) {
    await sleep(ms);
    while (!visible || document.hidden) await sleep(300);
  }

  // Position inside the unscaled stage; screen rectangles are skewed by the tilt.
  function centre(el, fx, fy) {
    let x = el.offsetWidth * fx;
    let y = el.offsetHeight * fy;
    for (let node = el; node && node !== stage; node = node.offsetParent) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return [x, y];
  }
  async function moveTo(el, fx = 0.5, fy = 0.55) {
    const [x, y] = centre(el, fx, fy);
    cursor.style.transform = `translate3d(${x}px, ${y}px, 30px)`;
    await wait(820);
  }
  async function click(el, fx, fy) {
    await moveTo(el, fx, fy);
    cursor.classList.add("down");
    el.classList.remove("pressed");
    void el.offsetWidth;
    el.classList.add("pressed");
    await wait(150);
    cursor.classList.remove("down");
    await wait(170);
  }
  async function type(text) {
    for (const letter of text) {
      typed.textContent += letter;
      await wait(85);
    }
  }
  function setTab(index) {
    tabs.forEach((tab, i) => tab.classList.toggle("on", i === index));
  }
  function choose(option) {
    for (const sibling of option.parentElement.children) sibling.classList.toggle("on", sibling === option);
    const freq = $(".seg-freq .on");
    const when = $(".seg-when .on");
    doseMain.textContent = "4 tabs, " + (freq ? freq.textContent : "…");
    doseSub.textContent = (when ? when.textContent + ", " : "") + "14 days";
    preview.classList.remove("bump");
    void preview.offsetWidth;
    preview.classList.add("bump");
  }
  function reset() {
    typed.textContent = "";
    search.classList.remove("focus");
    results.classList.remove("open");
    demo.querySelectorAll(".seg .on, .results .hover").forEach((el) => el.classList.remove("on", "hover"));
    doseMain.textContent = "4 tabs, …";
    doseSub.textContent = "14 days";
    finish.textContent = "Finalise and print label";
    finish.classList.remove("done");
    label.classList.remove("out");
    toast.classList.remove("out");
    visit.classList.remove("on");
    today.classList.remove("gone");
    today.classList.add("on");
    setTab(0);
  }
  function finalState() {
    reset();
    today.classList.remove("on");
    visit.classList.add("on");
    setTab(1);
    choose($(".seg-freq span:nth-child(2)"));
    choose($(".seg-when span:nth-child(1)"));
    finish.textContent = "Finalised";
    finish.classList.add("done");
    label.classList.add("out");
    toast.classList.add("out");
  }

  async function play() {
    for (;;) {
      reset();
      await wait(1300);
      await click(search, 0.3);
      search.classList.add("focus");
      await type("Anita");
      results.classList.add("open");
      await wait(500);
      const first = $(".results div");
      await moveTo(first, 0.4);
      first.classList.add("hover");
      await click(first, 0.4);
      results.classList.remove("open");
      search.classList.remove("focus");
      typed.textContent = "";
      today.classList.replace("on", "gone");
      visit.classList.add("on");
      setTab(1);
      await wait(1100);
      const twice = $(".seg-freq span:nth-child(2)");
      await click(twice);
      choose(twice);
      await wait(250);
      const before = $(".seg-when span:nth-child(1)");
      await click(before);
      choose(before);
      await wait(450);
      await click(finish);
      finish.textContent = "Finalised";
      finish.classList.add("done");
      await wait(250);
      label.classList.add("out");
      await wait(650);
      toast.classList.add("out");
      await moveTo(visit, 0.3, 0.75);
      await wait(4200);
    }
  }

  if (still) finalState();
  else play();
})();
