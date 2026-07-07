// Pure SandPiper SaaS client — framework-agnostic (no `vscode`, no `fs`).
//
// This is the reusable core of the experimental features. It POSTs TL-Verilog
// source to the public Makerchip SandPiper SaaS endpoint and returns the raw
// output map. Because it has no editor/filesystem dependencies, it can later be
// promoted to a shared workspace package (e.g. @rweda/sandpiper-saas) and reused
// by the Makerchip extension without dragging along VS Code wiring.
import axios from 'axios';

/** Public Makerchip SandPiper SaaS function endpoint. */
export const SANDPIPER_SAAS_URL = 'https://faas.makerchip.com/function/sandpiper-faas';

/**
 * Compile TL-Verilog via SandPiper SaaS.
 *
 * @param files  Map of filename -> file contents (must include the input `.tlv`).
 * @param args   SandPiper argument string (everything up to and including `--iArgs`).
 * @returns      The response output map (keys like `out/<name>.sv`, `.html`, `.svg`).
 */
export async function postSandpiper(
  files: Record<string, string>,
  args: string
): Promise<Record<string, string>> {
  const response = await axios.post(
    SANDPIPER_SAAS_URL,
    JSON.stringify({
      args,
      responseType: 'json',
      sv_url_inc: true,
      files
    }),
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  if (response.status !== 200) {
    throw new Error(`SandPiper SaaS request failed with status ${response.status}`);
  }

  return response.data;
}

/** Read a SandPiper formatting-settings-style string array from a config value. */
export function asArgList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}
