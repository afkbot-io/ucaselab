// Apply the cached appearance before CSS and React load. Storage may be unavailable.
(function () {
  var theme = "system";
  try {
    var saved = localStorage.getItem("ucaselab:theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch (_) {}
  var dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark
    ? "#141c2a"
    : "#f4f6fa";
})();
