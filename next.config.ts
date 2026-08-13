import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node", "sharp"],
  outputFileTracingIncludes: {
    // Widened from "/api/ask" only to all API routes. Next.js can put
    // @xenova/transformers into a shared webpack chunk that other route
    // handlers (like /api/chats) end up referencing even though they never
    // import it directly - and those functions don't get the actual files
    // bundled, so loading that shared chunk at runtime throws "Failed to
    // load external module @xenova/transformers". Including the files for
    // every API route avoids that mismatch.
    "/api/**": [
      "./node_modules/@xenova/transformers/**/*",
      "./node_modules/onnxruntime-node/**/*",
    ],
  },
};

export default nextConfig;