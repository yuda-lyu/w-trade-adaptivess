import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { entryExecOf, recursiveRootOf } from '../src/domain/verifyCmdScan.mjs'
import { scanTrace } from '../src/domain/verify.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//操作掃描之兩項新判定(規則 R-BT-7):
//  ①執行迴圈之寫檔入口(節點與做夢皆查): 指令執行 g_rsi.mjs 之寫入模式、g_launch.mjs、g_build.mjs、套件之命令列(src/cli/…)、寫檔之工具 ⇒「觸及禁區: 執行迴圈之寫檔入口(指令或路徑)」;
//    唯讀之模式與任務書之指令不列(判定同各入口之拒跑); 提到進入檔而無法解析者從嚴列出; 讀取類之指令之引數、寫入文件之文字不列
//  ②遞迴列出狀態根或其上層(節點、且呼叫端給 stateRoot): ls -R、find、tree、dir /s、Get-ChildItem -Recurse、遞迴之搜尋、非殼層之搜尋 / 列目錄工具、內嵌或寫入之腳本走訪目錄
//    ⇒「存取其他節點之工作夾(遞迴列出狀態根)」; 無法解析者從嚴列出; 做夢不查
//  既有之判定、鍵名、訊息與回傳之形狀不變(未給 stateRoot 之呼叫端只多 ① 一項)
let E = (c) => entryExecOf(c)
//內嵌腳本之子行程之樣本於執行時組出(本檔原文不含這些呼叫, 免被架構邊界之守門〔unit-guard〕當成本檔之呼叫)
let CP = ['child', '_process'].join('')
let EXS = ['exec', 'Sync'].join('')
let SPS = ['spawn', 'Sync'].join('')

describe('操作掃描:執行迴圈之寫檔入口(entryExecOf;規則 R-BT-7 ①)', function () {
    it('列:g_rsi 之寫入模式(含路徑前綴、反斜線、引號、cd 之後、管線與重導向)、g_launch、g_build、套件之命令列與寫檔之工具;經 env / npx / npm exec / time / 變數指派前綴者', () => {
        for (let c of [
            'node g_rsi.mjs --mode validate 2>&1 | tail -40',
            'node g_rsi.mjs --mode round',
            'node ./g_rsi.mjs --mode board',
            'node .\\g_rsi.mjs --mode board',
            'node "./my proj/g_rsi.mjs" --mode init',
            'cd rsi/work/aaaa111122223333 && node ../../../g_rsi.mjs --mode validate',
            'node g_rsi.mjs --mode frontier --close A01_nt --why x',
            'node g_rsi.mjs --mode fill --only abcdef',
            'node g_rsi.mjs --mode nosuchmode',
            'node node_modules/w-trade-adaptivess/src/cli/rsi.mjs --mode round',
            'node node_modules\\w-trade-adaptivess\\src\\cli\\backtest.mjs --pick p.mjs --name n',
            'node g_launch.mjs round -- g_rsi.mjs --mode status',
            'node g_build.mjs',
            'node tools/pickStore.mjs',
            'node tools/searchMap.mjs --quiet',
            'node tools/quota.mjs --probe',
            'node tools/roundDigest.mjs --out',
            'node tools/armDecide.mjs --id P001 --reject --why x',
            'node TOOLS/PICKSTORE.MJS',
            'node node_modules/w-trade-adaptivess/src/tools/initProject.mjs --root .',
            'npx node g_rsi.mjs --mode validate',
            'npm exec -- node g_rsi.mjs --mode validate',
            'env FOO=1 node g_rsi.mjs --mode round',
            'time node g_rsi.mjs --mode validate',
            'FOO=1 node --max-old-space-size=4096 g_rsi.mjs --mode validate',
            'node -r ./x.cjs g_rsi.mjs --mode board',
            'echo start; node g_rsi.mjs --mode board > rsi/work/aaaa111122223333/out.txt',
        ]) {
            assert.equal(E(c), true, c)
        }
    })

    it('從嚴列出:提到進入檔而無法解析(殼層 -c、xargs、PowerShell、變數、命令替換、引號不成對、直接執行、內嵌腳本起子行程、here-doc 交給殼層、變數之值提到進入檔)', () => {
        for (let c of [
            'bash -c "node g_rsi.mjs --mode status"',
            'pwsh -Command "node g_rsi.mjs --mode status"',
            'echo g_rsi.mjs | xargs node',
            'M=round; node g_rsi.mjs --mode $M',
            'node g_rsi.mjs --mode "$M"',
            'node $(echo g_rsi.mjs) --mode round',
            'node `echo g_rsi.mjs` --mode round',
            'node g_rsi.mjs --mode "status',
            './g_rsi.mjs --mode round',
            `node -e "require('${CP}').${EXS}('node g_rsi.mjs --mode round')"`,
            'bash <<\'EOF\'\nnode g_rsi.mjs --mode round\nEOF',
            `node - <<'EOF'\nrequire("${CP}").${SPS}("node", ["g_rsi.mjs", "--mode", "board"])\nEOF`,
            'G=g_rsi.mjs; node x.mjs',
            'npm run x -- g_rsi.mjs',
            '$NODE g_rsi.mjs --mode status',
            'node "$DIR/g_rsi.mjs" --mode status',
            'node g_rsi.mjs --mode status $EXTRA',
            './g_rsi.mjs --mode status $EXTRA',
            'node g_rsi.mjs --mode status \u00010\u0002',
        ]) {
            assert.equal(E(c), true, c)
        }
    })

    it('不列:唯讀之模式、任務書之指令(g_eval、g_toolbox、tools/logEvals)、只列出內容之工具、讀取類之指令之引數、寫入文件之文字、他腳本之引數;g_backtest 由既有之禁區字樣列出', () => {
        for (let c of [
            'node g_rsi.mjs',
            'node g_rsi.mjs --mode status',
            'node g_rsi.mjs --mode dry',
            'node g_rsi.mjs --mode frontier',
            'node g_rsi.mjs --mode fill --dry',
            'node g_rsi.mjs --mode=round',
            'node ./g_rsi.mjs --mode status 2>&1 | head -20',
            'node g_rsi.mjs --mode status > "$OUT"',
            './g_rsi.mjs --mode status',
            'npm exec -- node g_rsi.mjs --mode status',
            'npx node g_rsi.mjs --mode status',
            'npx -p w-trade-adaptivess node g_rsi.mjs --mode status',
            'env FOO=1 node g_rsi.mjs --mode status',
            'time node g_rsi.mjs --mode dry',
            'node --max-old-space-size=4096 -r ./x.cjs g_rsi.mjs --mode status',
            'node g_eval.mjs --pick rsi/work/aaaa111122223333/try_a.mjs --mode quick',
            'node g_eval.mjs --pick rsi/work/aaaa111122223333/try_a.mjs --mode full --out rsi/work/aaaa111122223333/full_a.json',
            'node g_eval.mjs --pick rsi/work/aaaa111122223333/try_a.mjs --mode quick --ref rsi/work/aaaa111122223333/control.mjs,rsi/work/aaaa111122223333/base_pick.mjs',
            'node g_toolbox.mjs',
            'node tools/logEvals.mjs rsi/work/aaaa111122223333/agent_a1.log',
            'node tools/scanCheck.mjs',
            'node tools/nodeAudit.mjs --nodes',
            'node tools/quota.mjs --all',
            'node tools/roundDigest.mjs 3',
            'node tools/armDecide.mjs',
            'node tools/briefPreview.mjs',
            'node node_modules/w-trade-adaptivess/src/tools/initProject.mjs --root . --dry',
            'cat g_rsi.mjs',
            'grep -n "mode" g_rsi.mjs src/cli/rsi.mjs',
            'rg "node g_rsi.mjs --mode round" docs/',
            'head -20 node_modules/w-trade-adaptivess/src/cli/rsi.mjs',
            'git diff g_build.mjs',
            'echo "node g_rsi.mjs --mode round" >> rsi/work/aaaa111122223333/notes.md',
            'cat > rsi/work/aaaa111122223333/notes.md <<\'EOF\'\nnode g_rsi.mjs --mode round\nEOF',
            'R=/opt/proj; node -e "\nconst fs=require(\'fs\');fs.appendFileSync(\'$R/sgud/feedback/feedback.md\', \'| 擴充診斷之補算(\\`node g_rsi.mjs --mode fill\\`) |\')\n"',
            'node rsi/work/aaaa111122223333/diag.mjs g_rsi.mjs',
            'node g_backtest.mjs --pick p.mjs --name n',
            'node g_evalx.mjs',
            'node tools/pickStoreX.mjs',
        ]) {
            assert.equal(E(c), false, c)
        }
    })
})

describe('操作掃描:遞迴列出狀態根或其上層(recursiveRootOf;規則 R-BT-7 ②)', function () {
    let root = path.resolve('/opt/proj')
    let stateRoot = path.join(root, 'rsi')
    let R = (c, base = root) => recursiveRootOf(c, { base, stateRoot }).hit

    it('列:列目錄與遞迴搜尋以狀態根或其上層為路徑(未給路徑 = 工作目錄;/ 與 \\;引號;絕對路徑;萬用字元之前段;cd 之後)', () => {
        let abs = stateRoot.replace(/\\/g, '/')
        for (let c of [
            'ls -R rsi', 'ls -laR rsi/', 'ls -R', 'ls -R .', 'ls -R ..', 'ls -R "rsi"', 'ls -R ./rsi/', 'ls -R rsi\\', `ls -R ${abs}`, 'ls --recursive rsi',
            'dir /s rsi', 'dir /s /b', 'find rsi -name "*.json"', 'find . -name x', 'find', 'find rsi/ -type f | head', 'tree rsi', 'tree', 'tree -L 2 .',
            'Get-ChildItem -Recurse rsi', 'gci -r -Path rsi', 'Get-ChildItem -Path . -Recurse -Filter *.json', 'Get-ChildItem rsi -Depth 2',
            'grep -rn foo rsi/', 'grep -r foo .', 'grep -R foo', 'grep -rl "x" rsi/*', 'rg foo', 'rg foo rsi', 'rg -n "x" .', 'rg --files', 'findstr /s foo *.md', 'findstr /s /i foo rsi\\*',
            'cd rsi && ls -R', 'cd rsi && find .', 'cd rsi/work && ls -R ..',
            'ls -R $D', 'ls -R ~', 'find "$HOME"',
            'bash -c "ls -R rsi"', 'cmd /c dir /s rsi', 'eval "ls -R rsi"', 'ls rsi | xargs grep -r x', 'echo `find rsi`',
            'ls -R rsi "',
            'node -e "\nconst fs=require(\'fs\');\nfunction walk(d,out){for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=d+\'/\'+f.name;if(f.isDirectory())walk(p,out);else out.push(p)}}\nconst out=[];walk(\'rsi\',out);console.log(out.join(\'\\n\'))\n"',
            'node -e "console.log(require(\'fs\').readdirSync(\'.\', { recursive: true }).length)"',
            'node -e "console.log(require(\'fs\').readdirSync(process.cwd(), { recursive: true }))"',
            'python -c "import os; print(list(os.walk(\'rsi\')))"',
            'bash <<\'EOF\'\nfind rsi -name "*.json"\nEOF',
            'node - <<\'EOF\'\nconst fs = require(\'fs\')\nconsole.log(fs.readdirSync(\'rsi\', { recursive: true }))\nEOF',
            'rg --no-such-flag x docs/', 'grep -r --no-such-flag x rsi/records',
            'echo rsi | xargs ls -R docs', 'ls | xargs -n 1 grep -r x docs', '$LS -R rsi',
        ]) {
            assert.equal(R(c), true, c)
        }
    })

    it('不列:非遞迴之列目錄與搜尋、狀態根以下之子夾、自己之工作夾、讀檔、評估、引號內跳脫之搜尋樣式、寫入文件之 here-doc、拼接路徑之前段、split 之「.」', () => {
        for (let c of [
            'ls rsi', 'ls -la rsi/work/aaaa111122223333', 'ls -r rsi', 'ls -lrt rsi', 'dir rsi', 'ls -R rsi/records', 'ls -R rsi/work/aaaa111122223333', 'find rsi/records -name "*.md"', 'tree rsi/toolbox',
            'grep -rn foo rsi/records/', 'grep -n foo rsi/work/aaaa111122223333/agent_a1.log', 'grep foo file.txt', 'rg foo docs/', 'rg -n "x" rsi/work/aaaa111122223333/agent_a1.log',
            'grep -o "mode full[^\\"]*" rsi/work/aaaa111122223333/agent_a1.log | head -20; echo ---; grep -o "\\"command\\":\\"[^\\"]*\\"" rsi/work/aaaa111122223333/agent_a1.log | head -60',
            'cat rsi/ARMS_BOARD.md', 'node g_eval.mjs --pick rsi/work/aaaa111122223333/try_a.mjs --mode quick', 'cd rsi/work/aaaa111122223333 && ls -R',
            'find rsi/records | xargs grep -l x', 'findstr foo *.md', 'Get-ChildItem rsi', 'gci -Path rsi/records -Recurse',
            'cat > rsi/work/aaaa111122223333/notes.md <<\'EOF\'\nls -R rsi\nEOF',
            'echo "ls -R rsi" >> rsi/work/aaaa111122223333/notes.md',
            'node -e "console.log(require(\'fs\').readdirSync(\'rsi/records/nodes\', { withFileTypes: true }).map((d) => d.name.split(\'.\')[0]))"',
            'node -e "const path=require(\'path\');const fs=require(\'fs\');const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).map((e)=>e.isDirectory()?walk(path.join(d,e.name)):e.name);console.log(walk(path.join(\'rsi\', \'records\')))"',
            'node -e "const fs=require(\'fs\');const p=\'rsi/work/aaaa111122223333/\';fs.writeFileSync(p+\'try_b.mjs\', fs.readFileSync(p+\'try_a.mjs\',\'utf8\'))"',
            'cat x.txt | grep foo', 'Get-ChildItem -Path rsi/records -Recurse -Filter *.json', 'tree -P \'*.md\' rsi/toolbox', 'bash -c "ls rsi/records"',
            'node -e "console.log(require(\'fs\').readdirSync(\'rsi\'))"',
            'node -e "require(\'fs\').rmSync(\'tmpx\', { recursive: true, force: true }); console.log(\'rsi\')"',
            'node -e "const fs=require(\'fs\');const path=require(\'path\');console.log(fs.readdirSync(path.join(process.cwd(), \'rsi\', \'records\'), { recursive: true }))"',
            'node -e "const fs=require(\'fs\');console.log(fs.readdirSync(\'rsi/records\', { recursive: true }).map((x) => x.split(\'/\')[0]))"',
        ]) {
            assert.equal(R(c), false, c)
        }
    })

    it('工作目錄:base 為 null(不確定)時相對路徑視為可能是;cd 之後之目錄依序解析並回傳', () => {
        assert.equal(R('ls -R records', null), true)
        assert.equal(R(`ls -R ${path.join(stateRoot, 'records').replace(/\\/g, '/')}`, null), false, '絕對路徑不受影響')
        assert.equal(R('ls -R .', path.join(stateRoot, 'records')), false)
        assert.equal(R('ls -R ..', path.join(stateRoot, 'records')), true)
        assert.equal(recursiveRootOf('cd rsi/records', { base: root, stateRoot }).dir, path.join(stateRoot, 'records'))
        assert.strictEqual(recursiveRootOf('cd $X', { base: root, stateRoot }).dir, null)
        assert.equal(recursiveRootOf('ls', { base: root, stateRoot }).dir, root)
        assert.strictEqual(recursiveRootOf('cd rsi/records && popd', { base: root, stateRoot }).dir, null)
        assert.strictEqual(recursiveRootOf('cd rsi "', { base: root, stateRoot }).dir, null, '無法解析而含切換目錄 ⇒ 不確定')
        assert.equal(recursiveRootOf('ls rsi "', { base: root, stateRoot }).dir, root, '無法解析而不含切換目錄 ⇒ 不變')
    })
})

describe('操作掃描:兩項新判定之接線(scanTrace;既有之判定不變)', function () {
    let t
    let root
    let workRoot
    let wd
    let fp
    let OWN = 'aaaa111122223333'
    let KE = '觸及禁區: 執行迴圈之寫檔入口(指令或路徑): '
    let KR = '存取其他節點之工作夾(遞迴列出狀態根): '
    beforeEach(() => {
        t = makeTmp('scanEntryExec')
        root = path.join(t.dir, 'proj')
        workRoot = path.join(root, 'rsi', 'work')
        wd = path.join(workRoot, OWN)
        fs.mkdirSync(wd, { recursive: true })
        fp = path.join(wd, 'agent_a1.log')
    })
    afterEach(() => {
        t.cleanup()
    })
    let oc = (tool, input) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input } } })
    let cl = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
    let node = (lines, opt = {}) => {
        fs.writeFileSync(fp, lines.join('\n'))
        return scanTrace({ workDir: wd, attempt: 1, privateRoot: path.join(t.dir, 'priv'), root, writeRoots: [wd], workRoot, nodeRules: true, ...opt })
    }
    let dream = (lines, opt = {}) => {
        let dd = path.join(workRoot, 'dream_r001')
        fs.mkdirSync(dd, { recursive: true })
        fs.writeFileSync(path.join(dd, 'agent.log'), lines.join('\n'))
        return scanTrace({ workDir: dd, logFile: path.join(dd, 'agent.log'), privateRoot: path.join(t.dir, 'priv'), root, writeRoots: [dd, path.join(root, 'sgud')], fileHits: 'note', ...opt })
    }
    let stateRoot = () => path.join(root, 'rsi')

    it('節點:執行寫入模式 ⇒ 列一項(訊息 = 鍵 + 指令之前 160 字;同鍵只列一次);遞迴列出狀態根只在給 stateRoot 時列;兩種紀錄之格式皆然', () => {
        let cmdE = 'node g_rsi.mjs --mode validate 2>&1 | tail -40'
        let cmdR = 'ls -R rsi'
        for (let mk of [(c) => oc('bash', { command: c, workdir: root }), (c) => cl('Bash', { command: c })]) {
            let lines = [mk(cmdE), mk('node g_rsi.mjs --mode board'), mk(cmdR)]
            let a = node(lines)
            assert.deepEqual(a.issues, [`${KE}${cmdE}`])
            let b = node(lines, { stateRoot: stateRoot() })
            assert.deepEqual(b.issues, [`${KE}${cmdE}`, `${KR}${cmdR}`])
        }
    })

    it('做夢:執行寫入模式照列;遞迴列出不列(即使給了 stateRoot)', () => {
        let lines = [cl('Bash', { command: 'node g_rsi.mjs --mode board' }), cl('Bash', { command: 'ls -R rsi' }), cl('Bash', { command: 'node g_toolbox.mjs' }), cl('Bash', { command: 'node g_rsi.mjs --mode status' })]
        assert.deepEqual(dream(lines).issues, [`${KE}node g_rsi.mjs --mode board`])
        assert.deepEqual(dream(lines, { stateRoot: stateRoot() }).issues, [`${KE}node g_rsi.mjs --mode board`])
    })

    it('合規之指令(任務書之範例與既有語料之形)⇒ 兩項皆不列,問題清單與未給 stateRoot 者逐字相同', () => {
        let cmds = [
            `node g_eval.mjs --pick rsi/work/${OWN}/try_a.mjs --mode quick`,
            `node g_eval.mjs --pick rsi/work/${OWN}/try_a.mjs --mode full --out rsi/work/${OWN}/full_a.json`,
            `node g_eval.mjs --pick rsi/work/${OWN}/try_a.mjs --mode quick --ref rsi/work/${OWN}/control.mjs`,
            `cp rsi/work/${OWN}/try_a.mjs rsi/work/${OWN}/pick.mjs`,
            'cat rsi/ARMS_BOARD.md', 'ls rsi/records/nodes', 'grep -rn "A01_nt" rsi/records/nodes/', `grep -n claimed rsi/work/${OWN}/node.json`,
            'node g_rsi.mjs --mode status', 'ls docs examples',
        ]
        let lines = [...cmds.map((c) => oc('bash', { command: c, workdir: root })), oc('read', { filePath: path.join(root, 'docs', 'pick-contract.md') }), oc('grep', { pattern: 'A01', path: path.join(root, 'rsi', 'records') }), oc('glob', { pattern: '*.md', path: path.join(root, 'docs') })]
        let a = node(lines)
        let b = node(lines, { stateRoot: stateRoot() })
        assert.deepEqual(a.issues, [])
        assert.deepStrictEqual(b, a)
    })

    it('工作目錄跨呼叫:未帶工作目錄之欄者沿用此前之 cd(另以專案根一併判);帶 workdir 者以之為準', () => {
        let r1 = node([cl('Bash', { command: 'cd rsi' }), cl('Bash', { command: 'ls -R' })], { stateRoot: stateRoot() })
        assert.deepEqual(r1.issues, [`${KR}ls -R`])
        let r2 = node([cl('Bash', { command: `cd rsi/work/${OWN}` }), cl('Bash', { command: 'ls -R records' })], { stateRoot: stateRoot() })
        assert.deepEqual(r2.issues, [], '兩個可能之工作目錄下皆不是狀態根或其上層')
        let r3 = node([oc('bash', { command: 'cd rsi', workdir: root }), oc('bash', { command: 'ls -R', workdir: path.join(root, 'rsi', 'records') })], { stateRoot: stateRoot() })
        assert.deepEqual(r3.issues, [])
        let r4 = node([cl('Bash', { command: 'cd $SOMEWHERE' }), cl('Bash', { command: 'ls -R records' })], { stateRoot: stateRoot() })
        assert.deepEqual(r4.issues, [`${KR}ls -R records`], 'cd 之目標無法確定 ⇒ 相對路徑視為可能是')
        let r5 = node([cl('Bash', { command: `cd rsi/work/${OWN}` }), cl('Bash', { command: 'ls -R ..' })], { stateRoot: stateRoot() })
        assert.deepEqual(r5.issues, [`${KR}ls -R ..`], '另以專案根判(新起之殼層之工作目錄):專案根之上層')
    })

    it('非殼層之搜尋 / 列目錄工具與寫入之程式檔:起點為狀態根或其上層者列;子夾、只一層之 glob、寫入文件之文字不列', () => {
        let rs = stateRoot()
        let hit = (lines) => node(lines, { stateRoot: rs }).issues.filter((x) => x.startsWith(KR)).length
        assert.equal(hit([oc('grep', { pattern: 'x', path: rs })]), 1)
        assert.equal(hit([oc('grep', { pattern: 'x' })]), 1, '未給起點 = 工作目錄(專案根)')
        assert.equal(hit([cl('Glob', { pattern: 'rsi/**/*.json' })]), 1)
        assert.equal(hit([oc('list', { path: rs })]), 1)
        assert.equal(hit([cl('LS', { path: root })]), 1)
        assert.equal(hit([oc('grep', { pattern: 'x', path: path.join(rs, 'records') })]), 0)
        assert.equal(hit([cl('Glob', { pattern: '**/*.md', path: path.join(rs, 'records') })]), 0)
        assert.equal(hit([cl('Glob', { pattern: '*.md' })]), 0, '只一層')
        let walkSrc = 'import fs from \'fs\'\nlet walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + \'/\' + e.name) : [e.name]))\nconsole.log(walk(\'rsi\'))\n'
        assert.equal(hit([oc('write', { filePath: path.join(wd, 'walk.mjs'), content: walkSrc })]), 1)
        assert.equal(hit([oc('write', { filePath: path.join(wd, 'notes.md'), content: walkSrc })]), 0, '文件之內容是文字')
        assert.equal(hit([oc('write', { filePath: path.join(wd, 'try_a.mjs'), content: 'export default function pick(ctx) { return [] }\n' })]), 0)
        assert.equal(hit([oc('write', { filePath: path.join(wd, 'ls.sh'), content: 'ls -R rsi\n' })]), 1)
    })
})
