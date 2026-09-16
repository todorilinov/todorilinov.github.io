/* The title of every admin page, as a menu of every admin page.

   Each app keeps its own page, reading only its own part of the database, so
   one app's data never shows up among another's. This file is the one list of
   those pages: a new app is a new line here, and every admin page offers it.

   A page marks its title with data-admin-nav; the title becomes a select that
   shows where you are and goes where you pick. Signing in is remembered per
   Firebase project: the TV DSP Center pages share one, Vocal Split has its
   own, so the first visit to each asks once. */
(() => {
  const PAGES = [
    { app: "TV DSP Center", pages: [
      ["admin.html", "Trials"],
      ["admin-insights.html", "Countries & devices"],
    ] },
    { app: "Vocal Split", pages: [
      ["admin-beta.html", "Beta applications"],
    ] },
  ];

  const style = document.createElement("style");
  style.textContent = `
    .admin-nav{position:relative;display:inline-block;max-width:100%}
    .admin-nav select{
      appearance:none;-webkit-appearance:none;max-width:100%;
      background:transparent;color:inherit;font:inherit;font-weight:600;
      border:1px solid transparent;border-radius:9px;
      padding:2px 34px 2px 8px;margin-left:-9px;cursor:pointer;
    }
    .admin-nav select:hover,.admin-nav select:focus{border-color:var(--line,#2a3038);outline:none;
      background:var(--card,#14181d)}
    .admin-nav select option,.admin-nav select optgroup{background:#14181d;color:#e6edf3;font-size:14px}
    .admin-nav::after{
      content:"";position:absolute;right:12px;top:50%;width:8px;height:8px;margin-top:-6px;
      border-right:2px solid var(--dim,#9aa4af);border-bottom:2px solid var(--dim,#9aa4af);
      transform:rotate(45deg);pointer-events:none;
    }`;
  document.head.appendChild(style);

  const here = (location.pathname.split("/").pop() || "admin.html").toLowerCase();

  function build(title) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Admin page");
    for (const { app, pages } of PAGES) {
      const group = document.createElement("optgroup");
      group.label = app;
      for (const [href, name] of pages) {
        const option = document.createElement("option");
        option.value = href;
        option.textContent = `${app} — ${name}`;
        option.selected = href.toLowerCase() === here;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    select.addEventListener("change", () => { location.href = select.value; });
    const holder = document.createElement("span");
    holder.className = "admin-nav";
    holder.appendChild(select);
    title.textContent = "";
    title.appendChild(holder);
  }

  function start() {
    document.querySelectorAll("[data-admin-nav]").forEach(build);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
