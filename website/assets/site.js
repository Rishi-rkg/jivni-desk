// Shared behaviour for every page: the backdrop video, photo slots,
// the clinic-size picker, the download page and the credits page.
(function () {
  const config = window.JIVNI;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };

  // ----- Backdrop video (the drifting placeholder stays underneath) -----
  const backdrop = document.querySelector(".backdrop");
  const ready = config.videos.filter((video) => video.src);
  if (backdrop && ready.length && !still && !(navigator.connection && navigator.connection.saveData)) {
    const pick = ready[Math.floor(Math.random() * ready.length)];
    const video = make("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = "metadata";
    if (pick.poster) video.poster = pick.poster;
    for (const [src, type] of [[pick.webm, "video/webm"], [pick.src, "video/mp4"]]) {
      if (!src) continue;
      const source = make("source");
      source.src = src;
      source.type = type;
      video.append(source);
    }
    video.addEventListener("canplay", () => video.classList.add("ready"), { once: true });
    backdrop.prepend(video);
  } else if (backdrop && !ready.length) {
    document.body.append(make("div", "backdrop-note", "Placeholder background, video to come"));
  }

  // ----- Photo slots -----
  for (const slot of document.querySelectorAll("[data-media]")) {
    const item = config.images.find((image) => image.id === slot.dataset.media);
    if (!item) continue;
    if (item.src) {
      const img = make("img");
      img.src = item.src;
      img.alt = item.alt;
      img.loading = "lazy";
      slot.prepend(img);
    } else {
      slot.classList.add("empty");
      const note = make("div");
      note.append(make("strong", "", "Placeholder photo"), item.brief);
      slot.prepend(note);
    }
  }

  // ----- Clinic size picker -----
  const sizes = document.querySelector(".sizes");
  if (sizes) {
    const content = {
      solo: {
        title: "Just you",
        text: "Register the patient, take the visit, print the label and the bill yourself. Nothing to configure for a team you don't have.",
        seats: [["Dr", "Doctor and owner"]],
      },
      team: {
        title: "A team of five",
        text: "Each person signs in as themselves and sees only what their work needs. Reception never sees clinical notes; the audit log shows who opened what.",
        seats: [["Dr", "Doctor and owner"], ["Dr", "Second doctor"], ["As", "Assistant"], ["Re", "Reception"], ["Bi", "Billing"]],
      },
      branches: {
        title: "Several branches",
        text: "Run each clinic on its own and manage them together on the Enterprise plan, with users and branding handled in one place.",
        seats: [["1", "Main clinic", true], ["2", "City branch", true], ["3", "Weekend clinic", true], ["Dr", "Doctors"], ["Re", "Front desks"]],
      },
    };
    const buttons = [...sizes.querySelectorAll("button")];
    const thumb = sizes.querySelector(".thumb");
    const title = document.getElementById("size-title");
    const text = document.getElementById("size-text");
    const seats = document.getElementById("size-seats");
    const place = (button) => {
      thumb.style.width = button.offsetWidth + "px";
      thumb.style.transform = `translate(${button.offsetLeft}px, ${button.offsetTop - 5}px)`;
    };
    const select = (button) => {
      buttons.forEach((b) => b.setAttribute("aria-selected", b === button));
      place(button);
      const chosen = content[button.dataset.size];
      title.textContent = chosen.title;
      text.textContent = chosen.text;
      seats.replaceChildren(
        ...chosen.seats.map(([badge, name, branch], i) => {
          const seat = make("div", branch ? "seat branch" : "seat");
          seat.style.animationDelay = i * 70 + "ms";
          seat.append(make("i", "", badge), name);
          return seat;
        }),
      );
    };
    buttons.forEach((button) => button.addEventListener("click", () => select(button)));
    const current = () => buttons.find((b) => b.getAttribute("aria-selected") === "true") || buttons[0];
    select(current());
    addEventListener("resize", () => place(current()));
    if (document.fonts) document.fonts.ready.then(() => place(current()));
  }

  // ----- Downloads -----
  const platforms = document.querySelector(".platforms");
  if (platforms) {
    const agent = navigator.userAgent;
    const mine = /Windows/.test(agent) ? "windows" : /Mac OS X|Macintosh/.test(agent) ? "macos" : /Linux|X11/.test(agent) && !/Android/.test(agent) ? "linux" : null;
    const card = mine && platforms.querySelector(`[data-os="${mine}"]`);
    if (card) {
      card.classList.add("yours");
      card.prepend(make("span", "tag", "For this computer"));
    }

    // File names come from packaging/build.py, for example
    // Jivni-1.0.0-windows-x64-setup.exe or jivni_1.0.0_amd64.deb.
    const kinds = {
      windows: [[/windows.*setup\.exe$/i, "Installer"], [/windows.*portable\.zip$/i, "Portable zip"]],
      macos: [[/macos.*\.dmg$/i, "Disk image"], [/macos.*portable\.zip$/i, "Portable zip"]],
      linux: [[/\.deb$/i, "Debian and Ubuntu package"], [/linux.*portable\.tar\.gz$/i, "Portable archive"]],
    };
    const chip = (name) => (/arm64|aarch64/i.test(name) ? "arm64" : "x64");
    const megabytes = (bytes) => Math.round(bytes / 1048576) + " MB";
    const line = document.getElementById("release-line");
    document.getElementById("all-releases").href = `https://github.com/${config.releasesRepo}/releases`;

    fetch(`https://api.github.com/repos/${config.releasesRepo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((release) => {
        let found = 0;
        for (const [os, patterns] of Object.entries(kinds)) {
          const box = platforms.querySelector(`[data-os="${os}"]`);
          const files = [];
          for (const [pattern, kind] of patterns) {
            for (const asset of release.assets.filter((a) => pattern.test(a.name))) files.push({ asset, kind, arch: chip(asset.name) });
          }
          if (!files.length) continue;
          found += files.length;
          // macOS buyers mostly have Apple silicon now; elsewhere x64 leads.
          const lead = files.find((f) => f.arch === (os === "macos" ? "arm64" : "x64")) || files[0];
          const button = box.querySelector(".btn");
          button.href = lead.asset.browser_download_url;
          button.removeAttribute("aria-disabled");
          button.textContent = `Download ${lead.kind.toLowerCase()} (${lead.arch}, ${megabytes(lead.asset.size)})`;
          const alt = box.querySelector(".alt");
          alt.replaceChildren(
            ...files.filter((f) => f !== lead).map((f) => {
              const link = make("a", "", `${f.kind}, ${f.arch} (${megabytes(f.asset.size)})`);
              link.href = f.asset.browser_download_url;
              return link;
            }),
          );
        }
        if (!found) return Promise.reject();
        const date = new Date(release.published_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
        line.replaceChildren(make("span", "dot live"), `Version ${release.tag_name.replace(/^v/, "")}, released ${date}. `);
        const notes = make("a", "", "Release notes");
        notes.href = release.html_url;
        line.append(notes);
      })
      .catch(() => {
        // No public release yet (or GitHub unreachable): the page keeps its
        // "not released yet" wording.
      });
  }

  // ----- Credits -----
  const credits = document.getElementById("media-credits");
  if (credits) {
    const rows = [...config.videos.map((v) => ({ ...v, kind: "Background video", what: v.title })), ...config.images.map((i) => ({ ...i, kind: "Photograph", what: i.brief }))];
    for (const item of rows) {
      const row = make("div", "credit");
      const body = make("div");
      body.append(make("strong", "", item.what), make("br"));
      if (item.src && item.author) {
        body.append(`By ${item.author}`);
        if (item.license) body.append(`, ${item.license}`);
        if (item.source) {
          const link = make("a", "", "Source");
          link.href = item.source;
          body.append(". ", link);
        }
      } else {
        body.append(make("span", "pending", "Placeholder. Not chosen yet; attribution will be listed here."));
      }
      row.append(make("div", "soft", item.kind), body);
      credits.append(row);
    }
  }

  for (const year of document.querySelectorAll("[data-year]")) year.textContent = new Date().getFullYear();
})();
