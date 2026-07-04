/* docs.ace X action buttons (Phase 3). Same-origin fetch to /api/x/*.
   Optimistic UI + fail-closed (D-10): fill on tap, revert + error on failure.
   This exact file's sha256 is pinned in the docs-host CSP script-src. */
(function () {
  "use strict";
  function post(action, tid, btn) {
    return fetch("/api/x/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Docs-Ace-CSRF": "1" },
      body: JSON.stringify({ tweet_id: tid })
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }
  function toast(msg, ok) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);" +
      "background:" + (ok ? "#1d9bf0" : "#c0392b") + ";color:#fff;padding:8px 16px;" +
      "border-radius:20px;font:14px system-ui;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.4)";
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-x-action]");
    if (!btn) return;
    e.preventDefault();
    var tid = btn.getAttribute("data-x-tid");
    var base = btn.getAttribute("data-x-action"); // "like" | "bookmark"
    var active = btn.classList.contains("x-active");
    var action = active ? "un" + base : base;
    // optimistic
    btn.classList.toggle("x-active");
    btn.disabled = true;
    post(action, tid, btn).then(function () {
      btn.disabled = false;
      toast((active ? "Removed " : "") + (base === "like" ? "♥ liked" : "🔖 bookmarked"), true);
    }).catch(function (code) {
      // fail closed: revert the optimistic fill + show error (never a silent success)
      btn.classList.toggle("x-active");
      btn.disabled = false;
      toast("Action failed (" + code + ")", false);
    });
  });
})();
