/** No CPU heuristic, process-name allowlist, or startup baseline: those hide daemons.
 * Exclude PID 1, kernel threads (PF_KTHREAD), and the probe's own ancestor chain.
 * Any unreadable process or Docker inspection failure blocks shutdown.
 */
export const IDLE_PROBE = String.raw`
import os, sys, json, socket, http.client, stat
workspace = sys.argv[1]
ignored = {1}
pid = os.getpid()
while pid > 1 and pid not in ignored:
    ignored.add(pid)
    text = open('/proc/%d/stat' % pid).read()
    pid = int(text[text.rfind(')')+2:].split()[1])
processes = []
for entry in os.listdir('/proc'):
    if not entry.isdigit() or int(entry) in ignored:
        continue
    try:
        text = open('/proc/'+entry+'/stat').read()
        fields = text[text.rfind(')')+2:].split()
        if fields[0] in ('Z', 'X', 'x') or (int(fields[6]) & 0x00200000):
            continue
        cmd = open('/proc/'+entry+'/cmdline', 'rb').read(4096).replace(b'\0', b' ').decode('utf8', 'replace')
        processes.append({'pid': int(entry), 'command': cmd or text[:text.rfind(')')+1]})
    except FileNotFoundError:
        pass
containers = []
try:
    mode = os.stat('/var/run/docker.sock').st_mode
except FileNotFoundError:
    mode = None
if mode is not None:
    if not stat.S_ISSOCK(mode):
        raise RuntimeError('Docker socket path is not a socket')
    conn = http.client.HTTPConnection('localhost', timeout=3)
    conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.sock.settimeout(3)
    conn.sock.connect('/var/run/docker.sock')
    conn.request('GET', '/containers/json')
    response = conn.getresponse()
    if response.status != 200:
        raise RuntimeError('Docker inspection failed: '+str(response.status))
    containers = json.loads(response.read(1048576))
    if not isinstance(containers, list):
        raise RuntimeError('Invalid Docker response')
    conn.close()
# An ad-hoc bind/overlay/tmpfs under the workspace is not represented by the
# offline backing volume. Stopping would lose this view (or tmpfs data).
workspace_mounts = []
for line in open('/proc/self/mountinfo'):
    fields = line.split()
    if len(fields) < 6: raise RuntimeError('Invalid mount inventory')
    if fields[4].startswith(workspace + '/'):
        workspace_mounts.append(fields[4])
print(json.dumps({'processes': processes, 'containers': containers, 'workspaceMounts': workspace_mounts}))
`;

export interface IdleEvidence {
	processes: Array<{ pid: number; command: string }>;
	containers: unknown[];
	workspaceMounts: string[];
	jobs?: Array<{ id: string; state: string }>;
}

export function parseIdleEvidence(text: string): IdleEvidence {
	const result = JSON.parse(text);
	if (!result || !Array.isArray(result.processes) || !Array.isArray(result.containers)
		|| !Array.isArray(result.workspaceMounts) || result.workspaceMounts.some((mount: unknown) => typeof mount !== "string")
		|| result.processes.some((p: any) => !Number.isInteger(p?.pid) || typeof p?.command !== "string")) {
		throw new Error("Incomplete VM activity evidence; shutdown refused");
	}
	return result;
}

/** Runs as the configured guest uid, so live writes preserve guest permissions and inotify.
 * Avoid atomic replacement: existing file modes/inodes (watchers, hardlinks) must survive.
 */
export const FILE_RPC = String.raw`
import os, sys, json, base64, stat
req = json.load(sys.stdin)
p = req['path']
op = req['op']
if op == 'read':
    st = os.stat(p)
    if not stat.S_ISREG(st.st_mode): raise RuntimeError('Only regular files can be read')
    with open(p, 'rb') as f: data = f.read(req['maxBytes']+1)
    if len(data) > req['maxBytes']: raise RuntimeError('File exceeds configured maxFileBytes')
    result = base64.b64encode(data).decode('ascii')
elif op == 'write':
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        st = os.stat(p)
        if not stat.S_ISREG(st.st_mode): raise RuntimeError('Only regular files can be written')
    except FileNotFoundError: pass
    with open(p, 'wb') as f: f.write(base64.b64decode(req['data']))
    result = None
elif op == 'mkdir':
    os.makedirs(p, exist_ok=True)
    result = None
elif op == 'stat':
    st = os.lstat(p)
    kind = 'symlink' if stat.S_ISLNK(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'other'
    result = {'kind': kind, 'size': st.st_size, 'mode': st.st_mode, 'uid': st.st_uid, 'gid': st.st_gid, 'mtimeMs': st.st_mtime * 1000, 'readonly': not os.access(p, os.W_OK)}
elif op == 'list':
    result = []
    with os.scandir(p) as entries:
        for e in entries:
            st = e.stat(follow_symlinks=False)
            kind = 'symlink' if e.is_symlink() else 'directory' if e.is_dir(follow_symlinks=False) else 'file' if e.is_file(follow_symlinks=False) else 'other'
            result.append({'path': e.name, 'kind': kind, 'size': st.st_size, 'mode': st.st_mode})
            if len(result) > 10000: raise RuntimeError('Directory exceeds 10000 entries')
else: raise RuntimeError('Unknown file operation')
print(json.dumps(result))
`;
