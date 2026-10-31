// Runs before the page's own scripts. Pages like Gmail catch every key press at the top of the page for their own
// shortcuts, and swallow it before it reaches Typefill's boxes. Key presses meant for an open Typefill box go to
// that box alone. content.js sets __typefillKey while a box it owns is open.

(() => {
  "use strict";
  if (globalThis.__typefillGuard) return;
  globalThis.__typefillGuard = true;

  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(type, (e) => {
      const hook = globalThis.__typefillKey;
      if (!hook || !(e.target instanceof Element) || e.target.localName !== "typefill-box") return;
      if (type === "keydown") hook(e);
      e.stopImmediatePropagation();
    }, true);
  }
})();
