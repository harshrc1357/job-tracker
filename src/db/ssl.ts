// Whether to force an encrypted database connection.
//
// postgres.js defaults to NO encryption. A Supabase connection string copied from the
// dashboard has no `sslmode`, so every query, with its email bodies and the Gmail refresh
// token, would cross the network in clear text. A remote host therefore gets "require".
// That encrypts the connection; it does not check the server's certificate, which would
// need the provider's CA bundle. The URL keeps the final say: if it names `sslmode` or
// `ssl`, this returns nothing and the URL wins. Local hosts stay unencrypted so the
// preview database and the tests keep working.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function sslOption(connectionString: string): "require" | undefined {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }

  if (url.searchParams.has("sslmode") || url.searchParams.has("ssl")) return undefined;
  return LOCAL_HOSTNAMES.has(url.hostname) ? undefined : "require";
}
