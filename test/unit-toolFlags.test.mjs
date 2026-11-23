import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CFG from '../src/cfg.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { TOOL_FLAGS, CLI_FLAGS, cliMsgOf } = CFG


//工具(src/tools/*.mjs)之命令列旗標之嚴格檢查(排程第 595 項之接續; 主控裁定 ⑥; R-EV-53): 寫入類與唯讀類工具之旗標: 等號寫法、未列之旗標、單值旗標重複、帶值旗標無值、多餘之值與位置引數一律拒收
//  (共用 cliMsgOf; 每工具一張旗標表 TOOL_FLAGS; 離開碼 2、固定單行訊息不帶輸入值; 於讀設定、組裝專案與任何寫入之前); 原: 一律靜默忽略(--root=<目錄> 把檔案寫入工作目錄、--dryrun 實際寫入、旗標被當成節點 id 前綴)
//  規格之句 ⇒ 案: 「每工具一張旗標表」= 盤點(工具檔 = 表之鍵; 工具讀取之旗標 = 表之鍵)、「共用 cliMsgOf」= 純函數之全工具案、「寫入類須於任何寫入之前」= 空之專案根實跑(專案根仍為空)與原始碼之次序、
//  「合法輸入之行為不變」= 合格之寫法通過檢查之對照
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let TOOLS_DIR = path.join(FD_ROOT, 'src', 'tools')
let toolNames = () => fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort()

//旗標之獨立預期(依各工具原始碼逐一寫成; 下「原始碼盤點」案核對其與表及原始碼一致)
let FLAGS = {
    archiveDocs: [],
    armDecide: ['id', 'accept', 'reject', 'why', 'why-file', 'name', 'layer', 'arm-id', 'title', 'title-file', 'desc', 'desc-file', 'selectable', 'no-grid'],
    armInactive: ['node', 'arms', 'why', 'offdef'],
    briefPreview: ['out'],
    buildCatalog: ['out'],
    dreamProfile: [],
    exposure: ['node', 'why', 'undo'],
    fakeRound: ['two', 'redream'],
    //成品之形式之補記(規則 R-REC-53)
    formSet: ['node', 'form', 'why'],
    improveTrend: ['json'],
    initProject: ['root', 'bar-hours', 'dry', 'force'],
    libCheck: ['json', 'dir-hi', 'dir-lo'],
    nodeAudit: ['nodes', 'shape'],
    pickStore: [],
    quota: ['max', 'all', 'probe'],
    rankCompare: ['k'],
    replayCheck: [],
    roundDigest: ['out'],
    scanCheck: [],
    searchMap: ['quiet'],
    smokeDispatch: [],
    waitEvent: ['timeout-min', 'since', 'poll-sec'],
}
//位置引數之個數上限(獨立預期)
let POS = { dreamProfile: 1, roundDigest: 1, scanCheck: 1, smokeDispatch: 1, replayCheck: Infinity }
let posOf = (n) => (n in POS ? POS[n] : 0)
//布林旗標(獨立預期; 其餘為帶值旗標)
let BOOL = {
    armDecide: ['accept', 'reject', 'no-grid'],
    exposure: ['undo'],
    fakeRound: ['two', 'redream'],
    improveTrend: ['json'],
    initProject: ['dry', 'force'],
    libCheck: ['json'],
    nodeAudit: ['nodes', 'shape'],
    quota: ['all', 'probe'],
    roundDigest: ['out'],
    searchMap: ['quiet'],
}
//無值由工具自己處理之旗標(沿用既有之固定訊息)
let OWN = { initProject: ['bar-hours'], libCheck: ['dir-hi', 'dir-lo'] }
let isBool = (n, f) => (BOOL[n] || []).includes(f)

describe('工具(src/tools/*.mjs)之命令列旗標之嚴格檢查(排程第 595 項之接續)', function () {
    this.timeout(600000)
    let t = makeTmp('toolFlags')
    after(() => t.cleanup())

    describe('表與原始碼之盤點', () => {
        it('TOOL_FLAGS 之鍵 = src/tools/ 內之全部工具(新增工具而未列表者即失敗); 各表之旗標與位置引數個數與獨立之預期相同; 旗標不與 CLI_FLAGS 之進入檔名衝突', () => {
            assert(TOOL_FLAGS && typeof TOOL_FLAGS === 'object', '有 TOOL_FLAGS')
            assert.deepEqual(Object.keys(TOOL_FLAGS).sort(), toolNames())
            assert.deepEqual(Object.keys(TOOL_FLAGS).sort(), Object.keys(FLAGS).sort())
            for (let n of toolNames()) {
                assert.deepEqual(Object.keys(TOOL_FLAGS[n].flags).sort(), [...FLAGS[n]].sort(), `${n}: 旗標`)
                assert.strictEqual(TOOL_FLAGS[n].positional, posOf(n), `${n}: 位置引數之個數`)
                for (let f of FLAGS[n]) {
                    assert.strictEqual(TOOL_FLAGS[n].flags[f] === null, isBool(n, f), `${n} --${f}: 布林與否`)
                }
                assert.deepEqual([...(TOOL_FLAGS[n].own || [])].sort(), [...(OWN[n] || [])].sort(), `${n}: own`)
                assert(!(n in CLI_FLAGS), `${n}: 不與進入檔同名`)
            }
        })

        it('各工具以 cliGuard(\'<名>\') 檢查, 且於讀設定、組裝專案與任何寫入之前(initProject 於其直接執行之區塊內、guardEntry 之後、initProject({ 之前); 有 guardEntry 者其後緊接', () => {
            for (let n of toolNames()) {
                let src = fs.readFileSync(path.join(TOOLS_DIR, `${n}.mjs`), 'utf8')
                let i = src.indexOf(`cliGuard('${n}')`)
                assert(i > 0, `${n}: 有 cliGuard`)
                assert.strictEqual(src.split(`cliGuard('${n}')`).length - 1, 1, `${n}: 只一處`)
                //次序: 檢查之前只有註解、import 與 guardEntry(無任何頂層之讀設定、組裝專案、寫入、派工; initProject 之檢查在其直接執行之區塊內, 另核對)
                if (n !== 'initProject') {
                    let before = src.slice(0, i).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(\/\/|\/\*|\*)/.test(l) && !/^import /.test(l) && !/^guardEntry\('/.test(l))
                    assert.deepEqual(before, [], `${n}: 檢查之前之頂層語句`)
                }
                if (src.includes(`guardEntry('${n}')`)) {
                    assert(src.indexOf(`guardEntry('${n}')`) < i, `${n}: guardEntry 在前`)
                    assert(/guardEntry\('[A-Za-z]+'\)\r?\n(?:\s*\/\/[^\n]*\r?\n)+\s*cliGuard\(/.test(src), `${n}: cliGuard 緊接於 guardEntry 之後`)
                }
            }
            //initProject: 區塊內之次序
            let ip = fs.readFileSync(path.join(TOOLS_DIR, 'initProject.mjs'), 'utf8')
            assert(ip.indexOf('guardEntry(\'initProject\')') < ip.indexOf('cliGuard(\'initProject\')') && ip.indexOf('cliGuard(\'initProject\')') < ip.lastIndexOf('r = initProject({'), 'initProject: 次序')
            assert(ip.indexOf('cliGuard(\'initProject\')') > ip.indexOf('if (process.argv[1] && path.resolve(process.argv[1])'), 'initProject: 在直接執行之區塊內(被匯入時不執行)')
        })

        it('原始碼盤點: 各工具讀取之旗標(argOf / argStrOf / process.argv.includes / indexOf / 區域輔助 arg、rateArg、textOf)= 表之旗標(textOf(\'x\') 讀 x 與 x-file); 位置引數只有表所列之工具讀取', () => {
            let nRead = 0
            for (let n of toolNames()) {
                let src = fs.readFileSync(path.join(TOOLS_DIR, `${n}.mjs`), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
                let read = new Set()
                for (let m of src.matchAll(/(?:argOf|argStrOf|argNumOf|rateArg|\barg)\('([a-z][\w-]*)'/g)) {
                    read.add(m[1])
                }
                for (let m of src.matchAll(/process\.argv\.(?:includes|indexOf)\('--([a-z][\w-]*)'\)/g)) {
                    read.add(m[1])
                }
                for (let m of src.matchAll(/\btextOf\('([a-z][\w-]*)'\)/g)) {
                    read.add(m[1])
                    read.add(`${m[1]}-file`)
                }
                nRead += read.size
                assert.deepEqual([...read].sort(), [...FLAGS[n]].sort(), `${n}: 讀取之旗標 = 表`)
                //位置引數: process.argv[2]、process.argv.slice(2)(不含 cliGuard 之自身)
                let readsPos = /process\.argv\[2\]|process\.argv\.slice\(2\)/.test(src)
                assert.strictEqual(readsPos, posOf(n) > 0, `${n}: 位置引數之讀取與表一致`)
            }
            assert(nRead >= 40, `掃描之範圍: ${nRead} 個旗標讀取`) //鑑別前提: 掃描確實找到讀取
        })

        it('本套件自己之文字與程式內出現之 `tools/<名>.mjs`(含 src/tools/ 與 node_modules/…/src/tools/)之後所寫之旗標皆在該工具之表內(盤點守門; 新增之文字若寫了不在表內之旗標即失敗)', () => {
            let walk = (dir, exts, out = []) => {
                for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (['node_modules', 'dist', 'docs', 'tmp', '_tmp', 'testPending', 'sgud'].includes(f.name)) {
                        continue
                    }
                    let fp = path.join(dir, f.name)
                    if (f.isDirectory()) {
                        walk(fp, exts, out)
                    }
                    else if (exts.some((e) => f.name.endsWith(e))) {
                        out.push(fp)
                    }
                }
                return out
            }
            let files = [
                ...walk(path.join(FD_ROOT, 'src'), ['.mjs']),
                ...walk(path.join(FD_ROOT, 'contract'), ['.md']),
                ...walk(path.join(FD_ROOT, 'examples'), ['.mjs', '.md', '.json']),
                path.join(FD_ROOT, 'README.md'),
                path.join(FD_ROOT, 'settings.json'),
            ].filter((f) => fs.existsSync(f))
            let names = toolNames().join('|')
            let re = new RegExp(`tools/(${names})\\.mjs`, 'g')
            let bad = []
            let nSeg = 0
            let nFlag = 0
            for (let fp of files) {
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((line, li) => {
                    let ms = [...line.matchAll(re)]
                    ms.forEach((m, k) => {
                        let seg = line.slice(m.index + m[0].length, k + 1 < ms.length ? ms[k + 1].index : line.length)
                        seg = seg.split(/[`'"”)）]/)[0]
                        nSeg++
                        for (let f of seg.matchAll(/(?:^|\s|\[)--([A-Za-z][\w-]*)(?=[\s\]|,.;:]|$)/g)) {
                            nFlag++
                            if (!(f[1] in TOOL_FLAGS[m[1]].flags)) {
                                bad.push(`${path.relative(FD_ROOT, fp)}:${li + 1} tools/${m[1]}.mjs --${f[1]}`)
                            }
                        }
                    })
                })
            }
            assert(nSeg >= 25 && nFlag >= 12, `掃描之範圍: ${nSeg} 個片段、${nFlag} 個旗標`) //鑑別前提
            assert.deepEqual(bad, [])
        })

        it('鑑別力: 掃描能抓到植入之違規(不在表內之旗標)', () => {
            let seg = 'node tools/exposure.mjs --node abc --perod x'
            let m = /tools\/(exposure)\.mjs/.exec(seg)
            let rest = seg.slice(m.index + m[0].length)
            let flags = [...rest.matchAll(/(?:^|\s|\[)--([A-Za-z][\w-]*)(?=[\s\]|,.;:]|$)/g)].map((x) => x[1])
            assert.deepEqual(flags.filter((f) => !(f in TOOL_FLAGS.exposure.flags)), ['perod'])
        })
    })

    describe('cliMsgOf(純函數): 全部工具', () => {
        it('各工具: 未列之旗標、等號寫法、單值旗標重複、帶值旗標無值、多餘之位置引數 ⇒ 固定訊息(不回顯輸入值); 全旗標各一次(帶值者給值)合格', () => {
            let nBad = 0
            for (let n of toolNames()) {
                let fl = FLAGS[n]
                let M = (a) => cliMsgOf(n, a)
                //未列之旗標(含冒號寫法、單獨之 --)
                let want = fl.length > 0 ? `invalid option: must be one of ${fl.map((x) => `--${x}`).join(', ')}` : 'invalid option: must be none (this command takes no options)'
                for (let a of [[`--zz${SECRET}`, 'x'], ['--perod'], ['--'], [`--${fl[0] || 'x'}:y`]]) {
                    assert.strictEqual(M(a), want, `${n} ${a.join(' ')}`)
                    nBad++
                }
                for (let f of fl) {
                    //等號寫法
                    let eq = M([`--${f}=${SECRET}`])
                    assert(typeof eq === 'string' && eq.startsWith(`invalid --${f}: must be written as --${f}`) && (eq.includes('(a space, not =)') || eq.includes('(a flag without a value, not =)')), `${n} --${f}=: ${eq}`)
                    assert(!eq.includes(SECRET), `${n} --${f}=: 不回顯`)
                    nBad++
                    let v = isBool(n, f) ? [] : [SECRET]
                    //重複
                    assert.strictEqual(M([`--${f}`, ...v, `--${f}`, ...v]), `invalid --${f}: must be given at most once`, `${n} --${f} 重複`)
                    nBad++
                    if (!isBool(n, f)) {
                        //無值(置末或其後接另一旗標): own 所列者交工具自己
                        let noVal = M([`--${f}`])
                        if ((OWN[n] || []).includes(f)) {
                            assert.strictEqual(noVal, null, `${n} --${f} 無值(own)`)
                        }
                        else {
                            assert.strictEqual(noVal, `invalid --${f}: must be written as --${f} ${TOOL_FLAGS[n].flags[f]} (a value is required)`, `${n} --${f} 無值`)
                            nBad++
                        }
                        //多餘之值: 位置引數已用盡(個數 0 或為 1 之工具之第二個)⇒ 拒收
                        if (posOf(n) === 0) {
                            assert(typeof M([`--${f}`, 'v', 'extra']) === 'string', `${n} --${f} v extra`)
                            nBad++
                        }
                    }
                    else if (posOf(n) === 0) {
                        //布林旗標之後接值
                        assert(typeof M([`--${f}`, 'v']) === 'string', `${n} --${f} v`)
                        nBad++
                    }
                }
                //全旗標各一次(帶值者給值)合格
                //  帶值旗標之合格樣本: 值之種類屬 CLI_VALUES 者(排程第 607 項)取其種類之合格值(其值之種類之案見 unit-cliValues), 其餘為任意字串
                let sample = (f) => {
                    let k = Object.prototype.hasOwnProperty.call(CFG.CLI_VALUES || {}, n) ? CFG.CLI_VALUES[n][f] : undefined
                    return k === undefined ? 'v' : (typeof k === 'object' ? k.enum[0] : { posInt: '3', num: '90', timerMin: '10', timerSec: '10', time: '2026-11-23T10:00:00Z' }[k])
                }
                let all = fl.flatMap((f) => [`--${f}`, ...(isBool(n, f) ? [] : [sample(f)])])
                assert.strictEqual(M(all), null, `${n}: 全旗標各一次`)
                assert.strictEqual(M([]), null, `${n}: 無引數`)
                //位置引數
                let p = posOf(n)
                if (p === 0) {
                    assert(typeof M(['pos']) === 'string', `${n}: 不收位置引數`)
                }
                else {
                    assert.strictEqual(M([n === 'smokeDispatch' ? 'node' : '1']), null, `${n}: 一個位置引數`)
                    if (Number.isFinite(p)) {
                        assert(typeof M(['1', '2']) === 'string', `${n}: 第二個位置引數拒收`)
                    }
                    else {
                        assert.strictEqual(M(['a', 'b', 'c', 'd']), null, `${n}: 位置引數不限個數`)
                    }
                }
            }
            assert(nBad >= 120, `拒收之案數 ${nBad}`) //鑑別前提
        })

        it('位置引數與布林旗標並用: roundDigest 之 [輪次] [--out](輪次可在 --out 前或後)、多一個位置引數拒; 無旗標之工具(replayCheck、dreamProfile、scanCheck、smokeDispatch)任何旗標拒; --out 於 briefPreview / buildCatalog 為帶值旗標(無值拒)', () => {
            let M = (n, a) => cliMsgOf(n, a)
            assert.strictEqual(M('roundDigest', ['3', '--out']), null)
            assert.strictEqual(M('roundDigest', ['--out', '3']), null)
            assert.strictEqual(M('roundDigest', ['--out']), null)
            assert.strictEqual(M('roundDigest', ['3']), null)
            assert(M('roundDigest', ['3', '4']), '第二個位置引數')
            assert(M('roundDigest', ['--out', '3', '4']), '第二個位置引數')
            assert(M('roundDigest', ['--out', '--out']), '重複')
            for (let n of ['replayCheck', 'dreamProfile', 'scanCheck', 'smokeDispatch']) {
                assert.strictEqual(M(n, ['--x']), 'invalid option: must be none (this command takes no options)', n)
                assert.strictEqual(M(n, ['--json']), 'invalid option: must be none (this command takes no options)', n)
            }
            assert.strictEqual(M('replayCheck', ['abcdef', '012345']), null)
            assert.strictEqual(M('briefPreview', ['--out']), 'invalid --out: must be written as --out <dir> (a value is required)')
            assert.strictEqual(M('buildCatalog', ['--out', 'x.json']), null)
        })

        it('own 旗標: libCheck 之 --dir-hi / --dir-lo 與 initProject 之 --bar-hours 之無值交由工具自己之解析(沿用既有之固定訊息); 重複仍由通用檢查拒收', () => {
            assert.strictEqual(cliMsgOf('libCheck', ['--dir-hi']), null)
            assert.strictEqual(cliMsgOf('libCheck', ['--dir-hi', '--json']), null)
            assert.strictEqual(cliMsgOf('libCheck', ['--dir-lo', '0.2', '--dir-lo', '0.3']), 'invalid --dir-lo: must be given at most once')
            assert.strictEqual(cliMsgOf('initProject', ['--bar-hours']), null)
            assert.strictEqual(cliMsgOf('initProject', ['--root']), 'invalid --root: must be written as --root <dir> (a value is required)')
        })
    })

    describe('各工具實跑(空之專案根: 離開碼 2、只一行之固定訊息、不寫任何檔、不回顯輸入值)', () => {
        let emptyRoot = path.join(t.dir, 'empty')
        fs.mkdirSync(emptyRoot, { recursive: true })
        let runTool = (n, args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: emptyRoot, ...env }
            delete e.ARSI_AGENT_ROLE
            delete e.ARSI_HARNESS
            let r = spawnSync(NODE, [path.join(TOOLS_DIR, `${n}.mjs`), ...args], { cwd: emptyRoot, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: `${r.stderr}` }
        }
        for (let n of toolNames()) {
            it(`${n}.mjs: 未列之旗標與等號寫法 ⇒ 離開碼 2、與 cliMsgOf 相同之固定訊息、專案根仍為空`, () => {
                let fl = FLAGS[n]
                let cases = [[`--zz-${SECRET}`, 'x']]
                if (fl.length > 0) {
                    cases.push([`--${fl[0]}=${SECRET}`])
                    let last = fl[fl.length - 1]
                    cases.push([`--${last}`, ...(isBool(n, last) ? [] : ['v']), '--zzz'])
                }
                for (let args of cases) {
                    let want = cliMsgOf(n, args)
                    assert(typeof want === 'string' && want.startsWith('invalid '), `${args.join(' ')}: 規格上應被拒`)
                    let r = runTool(n, args)
                    assert.strictEqual(r.status, 2, `${n} ${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)} ${r.err.slice(0, 200)}`)
                    assert.deepEqual(r.out, [want], `${n} ${args.join(' ')}`)
                    assert(!r.out.join('\n').includes(SECRET) && !r.err.includes(SECRET), `${n} ${args.join(' ')}: 不回顯`)
                    assert.deepEqual(fs.readdirSync(emptyRoot), [], `${n} ${args.join(' ')}: 不寫任何檔`)
                }
            })
        }

        it('寫入類之重點: initProject 於旗標不合時不建任何檔或資料夾(原: --root=<目錄> 被忽略而寫入工作目錄; --dryrun 被當成無此旗標而實際寫入); 合格之 --dry 對照(離開碼 0、列出將寫入者、仍不寫)', () => {
            let rootDir = path.join(t.dir, 'ipRoot')
            for (let args of [['--root', rootDir, '--dryrun'], [`--root=${rootDir}`], ['--root', rootDir, '--force', '--force'], ['--root'], ['--root', rootDir, 'extra'], ['--root', rootDir, '--dry', '--dry']]) {
                let r = runTool('initProject', args)
                assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)}`)
                assert.deepEqual(r.out, [cliMsgOf('initProject', args)])
                assert(!fs.existsSync(rootDir), `${args.join(' ')}: 不建專案根`)
                assert.deepEqual(fs.readdirSync(emptyRoot), [], `${args.join(' ')}: 工作目錄不寫任何檔`)
            }
            let ok = runTool('initProject', ['--root', rootDir, '--dry'])
            assert.strictEqual(ok.status, 0, ok.out.join(' | ').slice(0, 300) + ok.err.slice(0, 300))
            assert(ok.out.some((l) => l.includes('將寫入')), '--dry 列出將寫入者')
            assert(!fs.existsSync(rootDir), '--dry 不建專案根')
        })

        it('own 旗標實跑: libCheck --dir-hi 無值 ⇒ 離開碼 2 與 rateArg 之固定訊息(原有); initProject --bar-hours 無值 ⇒ 離開碼 2 與 invalid barHours(原有; 不建任何檔)', () => {
            let r = runTool('libCheck', ['--dir-hi'])
            assert.strictEqual(r.status, 2)
            assert.deepEqual(r.out, ['invalid --dir-hi: must be a number from 0 to 1'])
            let rootDir = path.join(t.dir, 'ipRoot2')
            let r2 = runTool('initProject', ['--root', rootDir, '--bar-hours'])
            assert.strictEqual(r2.status, 2, r2.out.join(' | ').slice(0, 300))
            assert(r2.out[0].startsWith('未執行: ') && r2.out[0].includes('barHours'), r2.out[0])
            assert(!fs.existsSync(rootDir))
        })

        it('對照: 合格之寫法通過檢查(唯讀之工具於空之專案根其後於讀設定時以「ERROR 無法讀取專案設定」離開; 無 invalid 之行)', () => {
            for (let [n, args] of [
                ['archiveDocs', []],
                ['pickStore', []],
                ['searchMap', ['--quiet']],
                ['nodeAudit', ['--nodes']],
                ['nodeAudit', ['--shape']],
                ['improveTrend', ['--json']],
                ['libCheck', ['--json', '--dir-hi', '0.8', '--dir-lo', '0.2']],
                ['rankCompare', ['--k', '5']],
                ['waitEvent', ['--timeout-min', '1', '--since', '2026-01-01T00:00:00Z', '--poll-sec', '2']],
                ['dreamProfile', ['3']],
                ['scanCheck', ['abcdef,012345']],
                ['roundDigest', ['3']],
                ['armDecide', []],
                ['armInactive', []],
                ['exposure', []],
                ['formSet', []],
                ['formSet', ['--node', 'abcdef', '--form', 'clue', '--why', 'w']],
                ['quota', ['--max', '90', '--all']],
                ['smokeDispatch', ['both']],
                ['briefPreview', []],
            ]) {
                let r = runTool(n, args)
                //各工具於設定讀不到時皆經 settingsOrExit 以離開碼 2 結束(訊息 ERROR 無法讀取專案設定; 在其引數檢查之後; 排程第 611 項 ①; 原: libCheck 以外為未捕捉之例外、離開碼 1)
                assert(r.out[0] && r.out[0].startsWith('ERROR 無法讀取專案設定'), `${n} ${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)}`)
                assert(!r.out.some((l) => l.startsWith('invalid ')), `${n} ${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)}`)
            }
            assert.deepEqual(fs.readdirSync(emptyRoot), [], '不寫任何檔')
        })
    })
})
