// Set IMPHOTOGENIC_API_URL to the publicly deployed API origin for production.
// The localhost default is only for running the API on the same computer.
(function () {
  const fromStorage = (() => {
    try {
      return localStorage.getItem("IMPHOTOGENIC_API_URL");
    } catch {
      return null;
    }
  })();

  const isLocalSite = ["localhost", "127.0.0.1", "::1"].includes(
    window.location.hostname,
  );

  // A localhost override saved during local development must not leak into a
  // hosted site, where it would point each visitor at their own computer.
  window.IMPHOTOGENIC_API_URL = isLocalSite
    ? fromStorage || window.IMPHOTOGENIC_API_URL || "http://127.0.0.1:8787"
    : "https://imphotogenic-api.onrender.com";
})();
