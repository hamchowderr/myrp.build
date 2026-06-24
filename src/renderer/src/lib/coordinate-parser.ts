export type CoordinateType = "blip" | "spawn" | "zone" | "shop" | "generic";

export interface ExtractedCoordinate {
  x: number;
  y: number;
  z: number;
  type: CoordinateType;
  source: {
    file: string;
    line: number;
    context: string;
  };
}

// GTA V world bounds (includes Cayo Perico island at ~4700, -5700)
const BOUNDS = { xMin: -4500, xMax: 6000, yMin: -6500, yMax: 8500 };

function inBounds(x: number, y: number): boolean {
  return x >= BOUNDS.xMin && x <= BOUNDS.xMax && y >= BOUNDS.yMin && y <= BOUNDS.yMax;
}

function classifyByContext(context: string): CoordinateType {
  const lower = context.toLowerCase();
  if (/blip|addblipfor/i.test(lower)) return "blip";
  if (/spawn|ped|player|respawn/i.test(lower)) return "spawn";
  if (/zone|area|poly/i.test(lower)) return "zone";
  if (/shop|store|vendor|dealer|market|garage/i.test(lower)) return "shop";
  return "generic";
}

const FLOAT = "-?\\d+\\.?\\d*";

// Pattern matchers in priority order
const patterns: Array<{
  regex: RegExp;
  type: CoordinateType | null; // null = classify by context
  extract: (m: RegExpMatchArray) => { x: number; y: number; z: number };
}> = [
  // AddBlipForCoord(x, y, z)
  {
    regex: new RegExp(
      `AddBlipForCoord\\s*\\(\\s*(${FLOAT})\\s*,\\s*(${FLOAT})\\s*,\\s*(${FLOAT})\\s*\\)`,
      "g",
    ),
    type: "blip",
    extract: (m) => ({
      x: parseFloat(m[1]),
      y: parseFloat(m[2]),
      z: parseFloat(m[3]),
    }),
  },
  // vector3(x, y, z) / vec3(x, y, z) / vector4(x, y, z, w)
  {
    regex: new RegExp(
      `(?:vector[34]|vec[34])\\s*\\(\\s*(${FLOAT})\\s*,\\s*(${FLOAT})\\s*,\\s*(${FLOAT})`,
      "g",
    ),
    type: null,
    extract: (m) => ({
      x: parseFloat(m[1]),
      y: parseFloat(m[2]),
      z: parseFloat(m[3]),
    }),
  },
  // {x = N, y = N, z = N} table literals
  {
    regex: new RegExp(
      `\\{\\s*x\\s*=\\s*(${FLOAT})\\s*,\\s*y\\s*=\\s*(${FLOAT})\\s*,\\s*z\\s*=\\s*(${FLOAT})`,
      "g",
    ),
    type: null,
    extract: (m) => ({
      x: parseFloat(m[1]),
      y: parseFloat(m[2]),
      z: parseFloat(m[3]),
    }),
  },
  // GetEntityCoords result used with coords.x, coords.y — skip these (runtime values)
  // SQL INSERTs with numeric triples: VALUES(..., x, y, z, ...)
  {
    regex: new RegExp(
      `VALUES\\s*\\([^)]*?(${FLOAT})\\s*,\\s*(${FLOAT})\\s*,\\s*(${FLOAT})[^)]*\\)`,
      "gi",
    ),
    type: null,
    extract: (m) => ({
      x: parseFloat(m[1]),
      y: parseFloat(m[2]),
      z: parseFloat(m[3]),
    }),
  },
];

/**
 * Extract GTA V coordinates from file contents.
 * Each file is { name, content } where name is the relative path.
 */
export function extractCoordinates(
  files: Array<{ name: string; content: string }>,
): ExtractedCoordinate[] {
  const results: ExtractedCoordinate[] = [];
  const seen = new Set<string>(); // dedup by "x,y,z"

  for (const file of files) {
    const lines = file.content.split("\n");

    for (const pat of patterns) {
      // Reset regex state
      pat.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration idiom
      while ((match = pat.regex.exec(file.content)) !== null) {
        const { x, y, z } = pat.extract(match);
        if (!inBounds(x, y)) continue;

        const key = `${x},${y},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Find line number
        const charIndex = match.index;
        let lineNum = 1;
        for (let i = 0; i < charIndex && i < file.content.length; i++) {
          if (file.content[i] === "\n") lineNum++;
        }

        const contextLine = lines[lineNum - 1]?.trim() ?? "";
        const type = pat.type ?? classifyByContext(contextLine);

        results.push({
          x,
          y,
          z,
          type,
          source: {
            file: file.name,
            line: lineNum,
            context: contextLine.slice(0, 120),
          },
        });
      }
    }
  }

  return results;
}
