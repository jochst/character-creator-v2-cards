import { connection } from "next/server";
import { configuredProviders } from "@/lib/providers";

/** Providers whose key is set on the server. Never returns keys. */
export async function GET() {
  await connection();
  return Response.json({ providers: configuredProviders() });
}
