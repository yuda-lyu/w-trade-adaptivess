import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createToolbox } from '../src/arsi/toolbox.mjs'
import { makeToolboxRules, TB_TRIGGER } from '../src/domain/toolboxRules.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//共用工具區之機械檢查(src/arsi/toolbox.mjs 檔頭之規則 ①~④; R-TB-1): 快照、差異、逐檔檢查與還原、索引一致性
describe('toolbox:共用工具區之機械檢查', function () {
    let t
    let dir
    beforeEach(() => {
        t = makeTmp('toolbox')
        dir = path.join(t.dir, 'tb')
    })
    afterEach(() => {
        t.cleanup()
    })

    let put = (rel, s) => {
        let fp = path.join(dir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.writeFileSync(fp, s)
    }

    it('ensure:建資料夾並以 indexSeed 寫索引(已有索引者不覆寫);list 列相對路徑、位元組數與雜湊', () => {
        let tb = createToolbox({ dir, indexSeed: '# 索引\n' })
        tb.ensure()
        assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# 索引\n')
        put('README.md', '# 改過\n')
        tb.ensure()
        assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# 改過\n')
        put('snippets/a.mjs', 'x')
        put('.hidden', 'h')
        assert.deepEqual(tb.list().map((f) => [f.rel, f.bytes]), [['README.md', 9], ['snippets/a.mjs', 1]], '以 . 開頭者不列')
        assert.match(tb.list()[1].hash, /^[0-9a-f]{12}$/)
    })

    it('diff:相對於快照之新增、修改、刪除', () => {
        let tb = createToolbox({ dir, indexSeed: 'i' })
        put('snippets/a.mjs', '1')
        put('snippets/b.mjs', '1')
        let snap = tb.snapshot()
        put('snippets/a.mjs', '2')
        fs.rmSync(path.join(dir, 'snippets', 'b.mjs'))
        put('diag/c.mjs', '3')
        assert.deepEqual(tb.diff(snap), { added: ['diag/c.mjs'], changed: ['snippets/a.mjs'], removed: ['snippets/b.mjs'] })
    })

    it('check:無變動 ⇒ 通過;索引未列之檔列為問題(不還原)', () => {
        let tb = createToolbox({ dir, indexSeed: '# 索引\n' })
        let snap = tb.snapshot()
        assert.deepEqual(tb.check(snap), { ok: true, changed: { added: [], changed: [], removed: [] }, reverted: [], issues: [] })
        put('snippets/a.mjs', 'x')
        let r = tb.check(snap)
        //規則 ④: 每個檔之相對路徑都須出現在索引內; 不合只列為問題
        assert.deepEqual([r.ok, r.reverted, r.issues, r.changed.added], [false, [], ['索引未列 snippets/a.mjs'], ['snippets/a.mjs']])
        put('README.md', '# 索引\nsnippets/a.mjs\n')
        assert.equal(tb.check(snap).ok, true)
    })

    it('check:副檔名不合、超過大小、專案注入之 checkFile 不過 ⇒ 該檔還原(新增者刪除、修改者回到快照之內容),其餘照留', () => {
        //規則 ①③: 逐檔檢查只及於本次新增 / 修改之檔; 不合者逐檔還原
        let tb = createToolbox({ dir, indexSeed: 'i', maxFileBytes: 20, checkFile: ({ rel, src }) => (/BAD/.test(src) ? [`${rel} 內容不合`] : []) })
        put('snippets/old.mjs', 'v1')
        put('README.md', 'snippets/old.mjs snippets/ok.mjs')
        let snap = tb.snapshot()
        put('snippets/old.mjs', 'BAD v2')
        put('snippets/ok.mjs', 'fine')
        put('snippets/new.exe', 'x')
        put('snippets/big.mjs', 'x'.repeat(21))
        put('snippets/bad.mjs', 'BAD')
        let r = tb.check(snap)
        assert.deepEqual(r.reverted.map((x) => x.rel).sort(), ['snippets/bad.mjs', 'snippets/big.mjs', 'snippets/new.exe', 'snippets/old.mjs'])
        assert(r.reverted.find((x) => x.rel === 'snippets/new.exe').why.includes('副檔名'))
        assert(r.reverted.find((x) => x.rel === 'snippets/big.mjs').why.includes('超過上限 20'))
        assert.equal(r.reverted.find((x) => x.rel === 'snippets/old.mjs').why, 'snippets/old.mjs 內容不合')
        assert.equal(fs.readFileSync(path.join(dir, 'snippets', 'old.mjs'), 'utf8'), 'v1', '修改者回到快照之內容')
        assert.deepEqual(fs.readdirSync(path.join(dir, 'snippets')).sort(), ['ok.mjs', 'old.mjs'], '新增而不合者刪除、合格者留下')
        assert.deepEqual(r.changed, { added: ['snippets/ok.mjs'], changed: [], removed: [] }, 'changed 為還原後之淨變動')
        assert.equal(r.ok, false)
    })

    it('check:已發布之檔被刪除 ⇒ 還原;索引被刪 ⇒ 還原;checkFile 拋錯 ⇒ 該檔還原並記原因;檔數超過上限列為問題', () => {
        //規則 ②: 已發布之檔不得刪除
        let tb = createToolbox({
            dir,
            indexSeed: 'snippets/a.mjs',
            maxFiles: 2,
            checkFile: ({ src }) => {
                if (/THROW/.test(src)) {
                    throw new Error('壞了')
                } return []
            }
        })
        put('snippets/a.mjs', '1')
        let snap = tb.snapshot()
        fs.rmSync(path.join(dir, 'snippets', 'a.mjs'))
        fs.rmSync(path.join(dir, 'README.md'))
        put('snippets/t.mjs', 'THROW')
        let r = tb.check(snap)
        assert.deepEqual(r.reverted.map((x) => x.rel).sort(), ['README.md', 'snippets/a.mjs', 'snippets/t.mjs'])
        assert(r.reverted.find((x) => x.rel === 'snippets/t.mjs').why.includes('檢查失敗: 壞了'))
        assert.equal(fs.readFileSync(path.join(dir, 'snippets', 'a.mjs'), 'utf8'), '1')
        assert.deepEqual(r.changed, { added: [], changed: [], removed: [] })
        put('README.md', 'snippets/a.mjs snippets/b.mjs')
        put('snippets/b.mjs', '2')
        assert(tb.check(tb.snapshot()).issues.some((x) => /共 3 檔,超過上限 2/.test(x)))
    })

    it('inspect:唯讀之自檢 —— 以同一套規則檢查現有之全部檔與索引,不還原、不改任何檔', () => {
        //toolbox.mjs 檔頭: inspect() 供擴建者於交付前自行確認(g_toolbox.mjs); 與 check 之逐檔規則相同, 但及於全部檔且不還原
        let tb = createToolbox({ dir, indexSeed: 'snippets/ok.mjs snippets/bad.mjs', maxFileBytes: 20, checkFile: ({ rel, src }) => (/BAD/.test(src) ? [`${rel} 內容不合`] : []) })
        tb.ensure()
        assert.deepEqual(tb.inspect(), { ok: true, files: [], issues: [] })
        put('snippets/ok.mjs', 'fine')
        put('snippets/bad.mjs', 'BAD')
        put('snippets/new.exe', 'x')
        let before = tb.list()
        let r = tb.inspect()
        assert.equal(r.ok, false)
        assert.deepEqual(r.files.map((f) => [f.rel, f.problems.length]), [['snippets/bad.mjs', 1], ['snippets/new.exe', 1], ['snippets/ok.mjs', 0]], '不含索引;逐檔列問題')
        assert.equal(r.files[0].problems[0], 'snippets/bad.mjs 內容不合')
        assert.deepEqual(r.issues, ['索引未列 snippets/new.exe'])
        assert.deepEqual(tb.list(), before, '自檢不改任何檔(不合者亦不還原)')
    })

    it('checkIndex(專案注入):索引之格式要求列為問題、不還原;專案規則 —— 須有「依情境找工具」一節且涵蓋每個工具檔', () => {
        //toolbox.mjs 檔頭之 checkIndex; src/domain/toolboxRules.mjs 之 checkIndex(R-TB-5): agent 不必讀程式碼即知何時用哪個工具
        let rules = makeToolboxRules({ privateRoot: path.join(t.dir, 'private') })
        let tb = createToolbox({ dir, indexSeed: rules.indexSeed, checkIndex: rules.checkIndex })
        tb.ensure()
        assert.deepEqual(tb.inspect().issues, [], '初始索引(無工具檔)合格')
        assert(rules.indexSeed.includes(TB_TRIGGER) && rules.indexSeed.includes('metrics/'))
        put('snippets/a.mjs', 'x')
        put('diag/b.mjs', 'y')
        let idx = path.join(dir, 'README.md')
        //只列在表內、不在「依情境找工具」一節 ⇒ 列為問題
        fs.writeFileSync(idx, `# 索引\n\n${TB_TRIGGER}\n\n| 要抽樣 | \`snippets/a.mjs\` |\n\n## 工具一覽\n\n| \`snippets/a.mjs\` | … |\n| \`diag/b.mjs\` | … |\n`)
        assert.deepEqual(tb.inspect().issues, ['「依情境找工具」一節未涵蓋 1 個檔: diag/b.mjs'])
        fs.writeFileSync(idx, `# 索引\n\n${TB_TRIGGER}\n\n| 要抽樣 | \`snippets/a.mjs\` |\n| 要比較結果檔 | \`diag/b.mjs\` |\n\n## 工具一覽\n\n| \`snippets/a.mjs\` | … |\n| \`diag/b.mjs\` | … |\n`)
        assert.deepEqual(tb.inspect().issues, [])
        //缺該節
        fs.writeFileSync(idx, '# 索引\n\nsnippets/a.mjs diag/b.mjs\n')
        assert(tb.inspect().issues.some((s) => s.includes('索引缺') && s.includes('依情境找工具')))
        //擴充診斷之靜態規則: 限制同挑選模組、須 export default(試跑另由真實評估器驗, 此處只驗靜態拒絕)
        let bad = rules.checkFile({ rel: 'metrics/x.mjs', abs: path.join(dir, 'metrics', 'x.mjs'), src: 'import fs from "fs"\nexport default function (api) { return {} }\n' })
        assert(bad.some((s) => s.includes('擴充診斷不合限制')))
        put('metrics/y.mjs', 'export function f(api) { return {} }\n')
        let noDef = rules.checkFile({ rel: 'metrics/y.mjs', abs: path.join(dir, 'metrics', 'y.mjs'), src: 'export function f(api) { return {} }\n' })
        assert(noDef.some((s) => s.includes('須 export default')))
    })
})
