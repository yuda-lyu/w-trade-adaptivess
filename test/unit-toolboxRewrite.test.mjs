import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { createToolbox } from '../src/arsi/toolbox.mjs'
import { makeToolboxRules, bodyOf, TB_TRIGGER, TB_BASELINE } from '../src/domain/toolboxRules.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { getSettings } from '../src/cfg.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//共用工具區: 已發布之檔於檔頭註解以外之內容不得改寫(src/arsi/toolbox.mjs 之規則 ⑤; 比對內容 = src/domain/toolboxRules.mjs 之 codeOf)
//  改寫 ⇒ 還原、理由寫明另存新檔名; 只改檔頭註解 ⇒ 照留; 新增之檔、文件檔與 metrics/ 第一層之檔不比對; 未注入 codeOf ⇒ 不檢查
//  自檢(g_toolbox.mjs)於另一行程, 以比對基準檔(最近一次快照所寫)比對
describe('toolbox:已發布之檔於檔頭註解以外之內容不得改寫', function () {
    this.timeout(120000)
    let t
    let dir
    let fpBase
    beforeEach(() => {
        t = makeTmp('tbRewrite')
        dir = path.join(t.dir, 'tb')
        fpBase = path.join(t.dir, 'state', 'baseline.json')
    })
    afterEach(() => {
        t.cleanup()
    })
    let put = (rel, s) => {
        let fp = path.join(dir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.writeFileSync(fp, s)
    }
    let get = (rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
    let rules = makeToolboxRules({ privateRoot: path.join(FD_ROOT, '..', 'no-private') })
    let mk = (opt = {}) => createToolbox({ dir, indexSeed: 'snippets/a.mjs snippets/b.mjs snippets/c.mjs notes/d.md', exts: ['.mjs', '.md'], codeOf: rules.codeOf, baselineFile: fpBase, ...opt })
    let V1 = '// 片段甲\nlet tieSeats = (ctx, ids, key, dir) => {\n    return { decided: ids.slice(0, key) }\n}\nexport { tieSeats }\n'

    it('bodyOf:檔頭之行(空行、行註解、區塊註解)不入比對;第一個不合之行起至檔尾皆為本體', () => {
        let same = (a, b, msg) => assert.equal(bodyOf(a), bodyOf(b), msg)
        let diff = (a, b, msg) => assert.notEqual(bodyOf(a), bodyOf(b), msg)
        assert.equal(bodyOf('// 說明\n\n/* 區塊\n * 多行\n */\nlet a = 1\n'), 'let a = 1')
        same('// 甲\nlet a = 1\n', '// 乙\n// 丙\n\nlet a = 1\n', '只改行註解')
        same('/* 甲 */\nlet a = 1\n', '  /* 乙\n丙 */   \nlet a = 1\n', '只改區塊註解(結束符之後至行尾只有空白)')
        diff('// 甲\nlet a = 1\n', '// 甲\nlet a = 2\n', '改程式碼')
        //行首與行尾皆為註解而中間改了程式碼: 以第一個結束符判定, 其後有內容 ⇒ 此行起為本體
        diff('/* a */ export let K = 5 /* b */\n', '/* a */ export let K = 6 /* b */\n', '同一行內註解之間之程式碼')
        assert.equal(bodyOf('/* a */ export let K = 5 /* b */\n'), '/* a */ export let K = 5 /* b */')
        diff('/* a\nb */ let K = 5\n', '/* a\nb */ let K = 6\n', '區塊註解之結束行接程式碼')
        assert.equal(bodyOf('/* a\nb */ let K = 5\n'), '/* a\nb */ let K = 5')
        //JS 之行終止符皆視為換行: 行註解之後接單獨之 CR、U+2028、U+2029 者, 其後之內容是程式碼
        for (let nl of ['\r', '\u2028', '\u2029']) {
            assert.equal(bodyOf(`// c${nl}let K = 5`), 'let K = 5', JSON.stringify(nl))
            diff(`// c${nl}let K = 5`, `// c${nl}let K = 6`, JSON.stringify(nl))
        }
        same('\uFEFF// 甲\nlet a = 1\n', '// 乙\nlet a = 1\n', '去 BOM')
        same('\uFEFFlet a = 1\n', 'let a = 1\n', '無檔頭之檔加 BOM')
        same('let a = 1\r\nlet b = 2\r\n', 'let a = 1\nlet b = 2\n', 'CRLF 與 LF')
        same('let a = 1\n', 'let a = 1   \n\n\n', '行尾空白與檔尾空行')
        //本體內之改動一律算改寫
        diff('let a = 1\nlet b = 2\n', 'let a = 1\n  let b = 2\n', '縮排')
        diff('let a = 1\nlet b = 2\n', 'let a = 1 // 行內註解\nlet b = 2\n', '本體之行內註解')
        diff('let a = 1\nlet b = 2\n', 'let a = 1\n\nlet b = 2\n', '本體之空行')
        diff('let a = 1\n', '// let a = 1\n', '程式碼改成註解')
        diff('/*\nlet a = 1\n*/\nlet b = 2\n', 'let a = 1\nlet b = 2\n', '程式碼包進檔頭之區塊註解')
        assert.equal(bodyOf('/* 未閉合\nlet a = 1\n'), '/* 未閉合\nlet a = 1', '未閉合之區塊註解 ⇒ 本體')
        //shebang 與 'use strict' 屬本體: 其後之註解之改動算改寫(偏嚴)
        diff('#!/usr/bin/env node\n// 甲\nlet a = 1\n', '#!/usr/bin/env node\n// 乙\nlet a = 1\n', 'shebang')
        diff('\'use strict\'\n// 甲\nlet a = 1\n', '\'use strict\'\n// 乙\nlet a = 1\n', 'use strict')
        assert.equal(bodyOf('// 只有註解\n\n'), '', '整檔只有註解 ⇒ 本體為空')
        diff('', 'let a = 1\n', '空檔加程式碼')
    })

    it('check:改寫已發布之檔之本體 ⇒ 還原、reverted 寫明另存新檔名與索引;只改檔頭註解或行尾空白 ⇒ 照留;新增之檔與文件檔不比對;其餘照留', () => {
        let tb = mk()
        for (let f of ['a', 'b', 'c', 'g']) {
            put(`snippets/${f}.mjs`, V1)
        }
        put('notes/d.md', '舊說明\n')
        let snap = tb.snapshot()
        //a: 改函數簽名; b: 只改檔頭註解與檔尾空行; c: 只改行尾空白; g: 改本體之縮排; d: 文件; e: 新增
        put('snippets/a.mjs', V1.replace('(ctx, ids, key, dir)', '(ctx, ids, key)'))
        put('snippets/b.mjs', `// 片段甲(補充說明)\n\n${V1.split('\n').slice(1).join('\n')}\n\n`)
        put('snippets/c.mjs', V1.replace('}\nexport', '}  \nexport'))
        put('snippets/g.mjs', V1.replace('    return', '        return'))
        put('notes/d.md', '新說明\n')
        put('snippets/e.mjs', 'let e = 1\nexport { e }\n')
        let r = tb.check(snap)
        assert.deepEqual(r.reverted.map((x) => x.rel), ['snippets/a.mjs', 'snippets/g.mjs'])
        let why = r.reverted[0].why
        assert(why.includes('檔頭註解以外') && why.includes('另存新檔名') && why.includes('_v2') && why.includes('已還原'), why)
        assert(why.includes('索引內對該檔之說明請一併復原'), why)
        assert.equal(get('snippets/a.mjs'), V1, '還原為快照之內容')
        assert.equal(get('snippets/g.mjs'), V1, '本體之縮排亦算改寫')
        assert(get('snippets/b.mjs').includes('補充說明'), '只改檔頭註解者照留')
        assert(get('snippets/c.mjs').includes('}  \nexport'), '只改行尾空白者照留')
        assert.equal(get('notes/d.md'), '新說明\n', '文件檔不比對')
        assert(fs.existsSync(path.join(dir, 'snippets', 'e.mjs')), '新增之檔不受影響')
        assert.equal(r.ok, false)
        assert.deepEqual(r.changed.changed.sort(), ['notes/d.md', 'snippets/b.mjs', 'snippets/c.mjs'])
    })

    it('metrics/ 之擴充診斷例外:同名改寫本體照留、比對基準檔不含其檔、自檢不列;同一次其他夾改寫本體照樣還原;任務書註明可同名修正', () => {
        let tb = mk()
        let V2 = V1.replace('slice(0, key)', 'slice(1, key)')
        put('metrics/m.mjs', V1)
        put('snippets/a.mjs', V1)
        let snap = tb.snapshot()
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fpBase, 'utf8')).codes), ['snippets/a.mjs'], '比對基準檔不含 metrics/ 之檔')
        put('metrics/m.mjs', V2)
        put('snippets/a.mjs', V2)
        let r = tb.check(snap)
        assert.deepEqual(r.reverted.map((x) => x.rel), ['snippets/a.mjs'])
        assert.equal(get('metrics/m.mjs'), V2, '擴充診斷可同名修正')
        assert.equal(get('snippets/a.mjs'), V1)
        //自檢(另一行程)亦不列
        put('metrics/m.mjs', V1.replace('slice(0, key)', 'slice(2, key)'))
        assert.deepEqual(mk().inspect().files.find((f) => f.rel === 'metrics/m.mjs').problems, [])
        assert.strictEqual(rules.codeOf({ rel: 'metrics/m.mjs', src: V1 }), null)
        assert.equal(typeof rules.codeOf({ rel: 'snippets/m.mjs', src: V1 }), 'string', '對照: 其他夾照比對')
        let tx = fs.readFileSync(path.join(FD_ROOT, 'src', 'domain', 'texts.mjs'), 'utf8')
        assert(tx.includes('之擴充診斷可同名修正') && tx.includes('改後由迴圈或補算工具重算'), '做夢任務書之對應文字')
    })

    it('metrics/ 之例外只及第一層之檔:子夾之檔照常比對(改寫還原、入比對基準檔、自檢列出)', () => {
        let tb = mk()
        let V2 = V1.replace('slice(0, key)', 'slice(1, key)')
        put('metrics/m.mjs', V1)
        put('metrics/sub/n.mjs', V1)
        let snap = tb.snapshot()
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fpBase, 'utf8')).codes), ['metrics/sub/n.mjs'], '比對基準檔只含子夾之檔')
        put('metrics/m.mjs', V2)
        put('metrics/sub/n.mjs', V2)
        let by = Object.fromEntries(mk().inspect().files.map((f) => [f.rel, f.problems]))
        assert.deepEqual(by['metrics/m.mjs'], [], '第一層之檔自檢不列')
        assert.equal(by['metrics/sub/n.mjs'].length, 1, '子夾之檔自檢列出')
        let r = tb.check(snap)
        assert.deepEqual(r.reverted.map((x) => x.rel), ['metrics/sub/n.mjs'])
        assert.equal(get('metrics/m.mjs'), V2, '第一層之檔可同名修正')
        assert.equal(get('metrics/sub/n.mjs'), V1, '子夾之檔還原')
        assert.strictEqual(rules.codeOf({ rel: 'metrics/m.mjs', src: V1 }), null)
        assert.equal(typeof rules.codeOf({ rel: 'metrics/sub/n.mjs', src: V1 }), 'string')
    })

    it('check:改寫字串之內容亦為改寫', () => {
        let tb = mk()
        put('snippets/a.mjs', 'let u = "a // 1"\nexport { u }\n')
        let snap = tb.snapshot()
        put('snippets/a.mjs', 'let u = "a // 2"\nexport { u }\n')
        assert.deepEqual(tb.check(snap).reverted.map((x) => x.rel), ['snippets/a.mjs'])
        assert.equal(get('snippets/a.mjs'), 'let u = "a // 1"\nexport { u }\n')
    })

    it('check:改寫之檔同時不合其他規則 ⇒ 只記一筆還原(理由為改寫);未改寫而不合其他規則者照舊依該規則還原', () => {
        let tb = mk({ checkFile: ({ src }) => (/BAD/.test(src) ? ['內容不合'] : []) })
        put('snippets/a.mjs', V1)
        put('snippets/b.mjs', V1)
        let snap = tb.snapshot()
        put('snippets/a.mjs', `${V1}let x = 'BAD'\n`)
        put('snippets/b.mjs', `// BAD\n${V1}`)
        let r = tb.check(snap)
        assert.deepEqual(r.reverted.map((x) => [x.rel, x.why.includes('另存新檔名')]), [['snippets/a.mjs', true], ['snippets/b.mjs', false]])
        assert.equal(r.reverted[1].why, '內容不合')
        //已發布之版本身即不合其他規則者被改寫 ⇒ 還原後不再依其他規則重複記一筆
        put('snippets/c.mjs', `${V1}let y = 'BAD'\n`)
        let snap2 = tb.snapshot()
        put('snippets/c.mjs', `${V1}let y = 'BAD2'\n`)
        assert.deepEqual(tb.check(snap2).reverted.map((x) => x.rel), ['snippets/c.mjs'])
    })

    it('未注入 codeOf ⇒ 不檢查改寫、不寫基準檔(與未加入本規則時相同)', () => {
        let tb = createToolbox({ dir, indexSeed: 'snippets/a.mjs', baselineFile: fpBase })
        put('snippets/a.mjs', V1)
        let snap = tb.snapshot()
        put('snippets/a.mjs', 'let a = 2\n')
        let r = tb.check(snap)
        assert.deepEqual(r.reverted, [])
        assert.equal(get('snippets/a.mjs'), 'let a = 2\n')
        assert(!fs.existsSync(fpBase))
        assert.deepEqual(tb.inspect().files[0].problems, [])
    })

    it('inspect(另一行程之自檢):依基準檔列出被改寫之檔(唯讀、不還原);只改檔頭註解、新增之檔不列;無基準檔或基準檔損毀 ⇒ 不比對、不拋錯', () => {
        put('snippets/a.mjs', V1)
        put('snippets/b.mjs', V1)
        mk().snapshot()
        assert(fs.existsSync(fpBase), '快照寫出基準檔')
        put('snippets/a.mjs', V1.replace('slice(0, key)', 'slice(1, key)'))
        put('snippets/b.mjs', `// 只改檔頭註解\n${V1}`)
        put('snippets/e.mjs', 'let e = 1\nexport { e }\n')
        //另一個物件(模擬另一行程): 記憶體內無快照
        let r = mk().inspect()
        let by = Object.fromEntries(r.files.map((f) => [f.rel, f.problems]))
        assert.equal(by['snippets/a.mjs'].length, 1)
        assert(by['snippets/a.mjs'][0].includes('_v2') && by['snippets/a.mjs'][0].includes('交付後會被還原'), by['snippets/a.mjs'][0])
        assert.deepEqual([by['snippets/b.mjs'], by['snippets/e.mjs']], [[], []])
        assert.equal(r.ok, false)
        assert(get('snippets/a.mjs').includes('slice(1, key)'), '自檢不還原')
        //基準檔損毀 / 不存在 ⇒ 不比對
        fs.writeFileSync(fpBase, '{ 壞掉', 'utf8')
        assert.deepEqual(mk().inspect().files.find((f) => f.rel === 'snippets/a.mjs').problems, [])
        fs.rmSync(fpBase)
        assert.deepEqual(mk().inspect().files.find((f) => f.rel === 'snippets/a.mjs').problems, [])
    })

    it('接線:專案物件之共用工具區於快照時寫基準檔於狀態根、改寫即還原', () => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.resources = {}
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: '測試不派工' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        fs.mkdirSync(path.join(st.records.toolboxDir, 'snippets'), { recursive: true })
        let fp = path.join(st.records.toolboxDir, 'snippets', 'a.mjs')
        fs.writeFileSync(fp, V1)
        let snap = P.toolbox.snapshot()
        assert(fs.existsSync(path.join(st.rsi.root, TB_BASELINE)), '基準檔在狀態根')
        fs.writeFileSync(fp, V1.replace('(ctx, ids, key, dir)', '(ctx, ids)'))
        assert.deepEqual(P.toolbox.check(snap).reverted.map((x) => x.rel), ['snippets/a.mjs'])
        assert.equal(fs.readFileSync(fp, 'utf8'), V1)
    })

    it('接線:命令列之自檢(子行程)依狀態根之基準檔列出被改寫之檔(離開碼 1);未改寫者離開碼 0', () => {
        let root = path.join(t.dir, 'cli')
        let tbDir = path.join(root, 'rsi', 'toolbox')
        fs.mkdirSync(path.join(tbDir, 'snippets'), { recursive: true })
        let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ ...base, resources: {}, rsi: { ...base.rsi, root: path.join(root, 'rsi') }, records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: tbDir } }), 'utf8')
        fs.writeFileSync(path.join(root, 'g_toolbox.mjs'), `import path from 'path'\nimport { fileURLToPath } from 'url'\nprocess.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', 'toolbox.mjs')).href)})\n`, 'utf8')
        let fp = path.join(tbDir, 'snippets', 'a.mjs')
        fs.writeFileSync(fp, V1)
        fs.writeFileSync(path.join(tbDir, 'README.md'), `# 索引\n\n${TB_TRIGGER}\n\n- 同分 → snippets/a.mjs\n`, 'utf8')
        //基準檔: 與專案物件同一位置、同一比對內容
        createToolbox({ dir: tbDir, codeOf: rules.codeOf, baselineFile: path.join(root, 'rsi', TB_BASELINE) }).snapshot()
        let run = () => {
            let env = { ...process.env }
            delete env.ARSI_ROOT
            return spawnSync(process.execPath, [path.join(root, 'g_toolbox.mjs')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, env })
        }
        let ok = run()
        assert.equal(ok.status, 0, ok.stdout + ok.stderr)
        fs.writeFileSync(fp, V1.replace('slice(0, key)', 'slice(2, key)'))
        let bad = run()
        assert.equal(bad.status, 1, bad.stdout + bad.stderr)
        assert(bad.stdout.includes('snippets/a.mjs') && bad.stdout.includes('_v2'), bad.stdout)
    })
})
