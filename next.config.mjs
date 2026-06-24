/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundle and load it
  // from node_modules at runtime on the server side only.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
