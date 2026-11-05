import { createHash } from 'node:crypto';
import { mobyDefaultSeccomp } from './moby-seccomp-default.ts';

export type DockerSandboxPolicy = 'docker-default' | 'codex-bwrap-v1';
export const codexSandboxArchitectures = ['amd64', 'arm64'] as const;

// Fixed Codex 0.166.0-alpha.5.1 bubblewrap namespace operations. The outer
// container stays non-root, capability-free, no-new-privileges and read-only.
// No arbitrary profile, unconfined mode, setns or clone3 permission is accepted.
const exact = (name: string, index: number, values: number[]) => values.map(value => ({
  names: [name], action: 'SCMP_ACT_ALLOW',
  args: [{ index, value, op: 'SCMP_CMP_EQ' }],
  includes: { arches: [...codexSandboxArchitectures] },
}));
const namespaceRules = [
  // USER|NS|IPC|PID[|NET]|SIGCHLD; both supported ABIs place flags in arg0.
  ...exact('clone', 0, [0x38020011, 0x78020011]),
  ...exact('unshare', 0, [0x10000000]), // Only CLONE_NEWUSER.
  ...exact('umount2', 1, [2]), // Only MNT_DETACH.
  { names: ['pivot_root'], action: 'SCMP_ACT_ALLOW', includes: { arches: [...codexSandboxArchitectures] } },
  // Exact mount flags used by this bubblewrap version, including its 64
  // bind-remount combinations. Kernel locked read-only mount flags still apply.
  ...exact('mount', 3, [6, 10, 14, 36864, 36898, 36899, 36902, 36903, 36906, 36907, 36910, 36911, 37922, 37923, 37926, 37927, 37930, 37931, 37934, 37935, 38946, 38947, 38950, 38951, 38954, 38955, 38958, 38959, 39970, 39971, 39974, 39975, 39978, 39979, 39982, 39983, 53248, 311296, 573440, 2134050, 2134051, 2134054, 2134055, 2134058, 2134059, 2134062, 2134063, 2135074, 2135075, 2135078, 2135079, 2135082, 2135083, 2135086, 2135087, 2136098, 2136099, 2136102, 2136103, 2136106, 2136107, 2136110, 2136111, 2137122, 2137123, 2137126, 2137127, 2137130, 2137131, 2137134, 2137135, 3236810752]),
];
export const codexSeccompJson = JSON.stringify({
  ...mobyDefaultSeccomp, syscalls: [...mobyDefaultSeccomp.syscalls, ...namespaceRules],
});
export const codexSeccompDigest = createHash('sha256').update(codexSeccompJson).digest('hex');
export function dockerSecurityOptions(policy: DockerSandboxPolicy): string[] {
  return policy === 'codex-bwrap-v1'
    ? ['no-new-privileges:true', 'seccomp=' + codexSeccompJson]
    : ['no-new-privileges:true'];
}
