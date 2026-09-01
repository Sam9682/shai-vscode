(function () {
  const vscode = acquireVsCodeApi();
  let knownIds = [], currentActive = "", predefinedIds = [];

  function g(id) { return document.getElementById(id); }

  function sanitizeId(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "-";
      out += ok ? c : "_";
    }
    return out;
  }

  // ---- Toggle new context form ----
  g("btnToggleNew").addEventListener("click", function() {
    const s = g("newCtxSection");
    const opening = s.classList.contains("hidden");
    s.classList.toggle("hidden");
    this.textContent = opening ? "- New context" : "+ New context";
    if (opening) {
      g("newCtxId").value = "";
      g("newCtxSystem").value = "";
      g("newCtxError").classList.add("hidden");
      g("newCtxSanitizeNotice").classList.add("hidden");
      g("newCtxId").focus();
    }
  });

  // ---- Sanitize preview notice ----
  g("newCtxId").addEventListener("input", function() {
    const raw = this.value;
    const safe = sanitizeId(raw);
    const notice = g("newCtxSanitizeNotice");
    if (safe !== raw) {
      notice.textContent = "Spaces and special characters will be replaced with underscores \u2192 " + safe;
      notice.classList.remove("hidden");
    } else {
      notice.classList.add("hidden");
    }
  });

  // ---- Template selector ----
  g("newCtxTemplate").addEventListener("change", function() {
    const opt = this.options[this.selectedIndex];
    if (opt && typeof opt.dataset.systemPrompt === "string") {
      g("newCtxSystem").value = opt.dataset.systemPrompt;
    }
  });

  g("btnCancelCreate").addEventListener("click", function() {
    g("newCtxSection").classList.add("hidden");
    g("btnToggleNew").textContent = "+ New context";
  });

  g("btnCreateCtx").addEventListener("click", function() {
    const raw  = g("newCtxId").value.trim();
    const safe = sanitizeId(raw);
    g("newCtxError").classList.add("hidden");
    if (!safe) { g("newCtxId").focus(); return; }
    // Duplicate name: show the error and retain the entered values (do NOT clear/hide the
    // form and do NOT post 'newContext'). The early return keeps #newCtxId and
    // #newCtxSystem intact. (Req 4.5)
    if (knownIds.indexOf(safe) !== -1 || predefinedIds.indexOf(safe) !== -1) { g("newCtxError").classList.remove("hidden"); return; }
    vscode.postMessage({ type: "newContext", id: safe, systemPrompt: g("newCtxSystem").value });
    g("newCtxSection").classList.add("hidden");
    g("btnToggleNew").textContent = "+ New context";
  });

  // ---- Selector ----
  g("ctxSelect").addEventListener("change", function() {
    const id = this.value;
    g("btnDeleteCtx").disabled = knownIds.length <= 1 || predefinedIds.indexOf(id) !== -1;
    g("confirmDeleteCtx").classList.add("hidden");
    if (id && id !== currentActive) { vscode.postMessage({ type: "switchContext", id: id }); }
  });
  g("btnDeleteCtx").addEventListener("click", function() {
    const id = g("ctxSelect").value;
    if (!id || predefinedIds.indexOf(id) !== -1) { return; }
    g("confirmDeleteCtx").classList.remove("hidden");
  });
  g("confirmDeleteCtxYes").addEventListener("click", function() {
    const id = g("ctxSelect").value;
    g("confirmDeleteCtx").classList.add("hidden");
    if (id) { vscode.postMessage({ type: "deleteContext", id: id }); }
  });
  g("confirmDeleteCtxNo").addEventListener("click", function() {
    g("confirmDeleteCtx").classList.add("hidden");
  });

  // ---- System prompt ----
  g("btnSaveSystem").addEventListener("click", function() {
    vscode.postMessage({ type: "saveSystemPrompt", value: g("systemPrompt").value });
  });

  // ---- Preview prompt ----
  g("btnPreview").addEventListener("click", function() {
    vscode.postMessage({ type: "previewPrompt", userMessage: g("previewInput").value || "(your message here)" });
  });

  // ---- Messages ----
  window.addEventListener("message", function(e) {
    const msg = e.data;
    if (msg.type === "previewResult") {
      g("previewOutput").textContent = msg.text;
      g("previewOutput").classList.remove("hidden");
      return;
    }
    if (msg.type !== "init") { return; }

    knownIds = msg.contextIds || [];
    currentActive = msg.activeId || "default";
    predefinedIds = msg.predefinedIds || [];

    var labels = { "default": "Default", "dev": "Dev", "devops": "DevOps", "spec": "Spec", "docker-compose": "Docker Compose" };

    var sel = g("ctxSelect");
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    knownIds.forEach(function(id) {
      var opt = document.createElement("option");
      opt.value = id;
      var display = labels[id] || id;
      if (predefinedIds.indexOf(id) !== -1) { display = "📌 " + display; }
      opt.textContent = id === currentActive ? display + "  *" : display;
      if (id === currentActive) { opt.selected = true; }
      sel.appendChild(opt);
    });
    g("activeName").textContent = labels[currentActive] || currentActive;
    g("btnDeleteCtx").disabled  = knownIds.length <= 1 || predefinedIds.indexOf(sel.value) !== -1;

    var templates = msg.templates || [];
    var tplSel = g("newCtxTemplate");
    while (tplSel.firstChild) tplSel.removeChild(tplSel.firstChild);
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "None (blank)";
    none.dataset.systemPrompt = "";
    tplSel.appendChild(none);
    templates.forEach(function(t) {
      var opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label || t.id;
      opt.dataset.systemPrompt = t.systemPrompt || "";
      tplSel.appendChild(opt);
    });

    const st = msg.state || {};
    g("systemPrompt").value = st.systemPrompt || "";
  });

  vscode.postMessage({ type: "getInit" });
})();
