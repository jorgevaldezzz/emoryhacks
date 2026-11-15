// Point this at the API host (the separate server that holds SQLite + uploads).
// On Vercel you can also set it in the browser console:
//   localStorage.setItem("IMPHOTOGENIC_API_URL", "https://your-api-host.example.com")
(function () {
  const fromStorage = (() => {
    try {
      return localStorage.getItem("IMPHOTOGENIC_API_URL");
    } catch {
      return null;
    }
  })();

  window.IMPHOTOGENIC_API_URL =
    fromStorage ||
    window.IMPHOTOGENIC_API_URL ||
    "http://127.0.0.1:8787";
})();
