# Vendoring NSSM

`ops/installWindowsService.js` needs `nssm.exe` at this exact path:

```
ops/vendor/nssm.exe
```

It isn't included in this repo/bundle and can't be fetched automatically --
neither the production server (no internet access at all) nor the
environment this app was built in can reach nssm.cc. This is a one-time
manual step, done once on any machine that does have internet access:

1. Go to https://nssm.cc/download and download the latest release zip
   (e.g. `nssm-2.24.zip`).
2. Extract it. Inside, you'll find `win32/nssm.exe` and `win64/nssm.exe`.
3. Take the **win64** one (unless this server is genuinely 32-bit Windows,
   which is very unlikely) and copy it here as:
   ```
   ops/vendor/nssm.exe
   ```
4. Commit it (if you're able to push to the repo) or just carry it along
   in the offline deployment bundle -- either way, `ops/installWindowsService.js`
   just needs to find it at that path.

Once it's in place, run (from an elevated/Administrator prompt, from the
app's root folder):

```
npm run setup:windows-service
sc start "server-watch-svc"
npm run service:status
```

`npm run service:status` / `:start` / `:stop` / `:restart` all work the
same either way -- they detect whether this NSSM-based service is installed
and use it automatically, falling back to PM2 if not.
