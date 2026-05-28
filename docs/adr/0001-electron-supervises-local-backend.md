# Electron supervises a local backend

RepoBinder uses Electron as a local supervisor that starts an HTTP backend, waits for `/health`, and loads the same React app that a browser can open from the backend. This keeps desktop and browser access on one API and UI surface while still allowing remote access by changing the backend bind host from `127.0.0.1` to `0.0.0.0`; remote mode must receive authentication before it is treated as safe outside trusted networks.
