import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const BASE_MODEL = `package Vehicle {
    import ScalarValues::*;

    part def Vehicle {
        part chassis : Chassis;
    }

    part def Chassis {
        attribute frameMass : Real = 120.0;
    }

    requirement def MassRequirement {
        attribute text : String = "The vehicle mass shall not exceed 2000 kg.";
    }

    verification def MassVerification {
        subject v : Vehicle;
        objective {
            verify MassRequirement;
        }
    }
}
`;

export const BROKEN_MODEL = `package Broken {
    part def A {
        part b : MissingType;
    }
}
`;

export interface TempWorkspace {
  dir: string;
  cleanup(): Promise<void>;
}

export async function tempWorkspace(files: Record<string, string> = { 'model.sysml': BASE_MODEL }): Promise<TempWorkspace> {
  const base = process.env.SYSML_AI_TMP && existsSync(process.env.SYSML_AI_TMP) ? process.env.SYSML_AI_TMP : tmpdir();
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(join(base, `sysml-ai-test-${randomUUID().slice(0, 8)}-`));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, content, 'utf8');
  }
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export async function readWorkspaceFile(dir: string, name: string): Promise<string> {
  return fs.readFile(join(dir, name), 'utf8');
}

export async function writeWorkspaceFile(dir: string, name: string, content: string): Promise<void> {
  const path = join(dir, name);
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}
