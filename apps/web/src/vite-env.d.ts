// Build-time settings the web app reads from import.meta.env (listed in apps/web/.env.example).
declare global {
  interface ImportMetaEnv {
    /** The API's root URL, `/api` prefix included; `/api` on the web app's origin when unset. */
    readonly VITE_API_URL?: string;
    /** Where the footer's "Source" link points; the public repository when unset. */
    readonly VITE_SOURCE_URL?: string;
  }
}

export {};
