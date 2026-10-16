// fetch() rejects with a TypeError when no response arrives at all (offline,
// VPN drop, DNS). The browser wording differs ("Failed to fetch", "NetworkError
// when attempting to fetch resource.", "Load failed") and none of it says the
// server is unreachable. The service worker serves the cached shell offline, so
// the sign-in form still renders and this is the only signal the user gets.
export function authErrorMessage(err: unknown): string {
  if (err instanceof TypeError) {
    return "Can't reach the MindBlown server — check your connection and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong';
}
