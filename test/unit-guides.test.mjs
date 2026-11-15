import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts, GUIDE, guideText } from '../src/domain/texts.mjs'
import { makeTmp } from './tools/synthLedger.mjs'

//寫法守則(規則 R-MON-3): 「方向該怎麼寫、判定該怎麼定、節點實驗之通則」由做夢自己維護兩個檔, 其條目原文附於做夢 / 節點任務書之末 —— 監控不必再為這類改進改任務書
describe('guides:做夢自己維護之寫法守則', function () {
    let t
    let st = getSettings()
    before(() => {
        t = makeTmp('guides')
        fs.mkdirSync(path.join(t.dir, 'sgud', 'proc'), { recursive: true })
    })
    after(() => {
        t.cleanup()
    })
    let wd = path.join(st.records.workDir, 'nodeX')
    let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
    let task = { goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox: null, trial: null }
    let nodeBrief = (texts) => texts.nodeBrief({ workDir: wd, task, round: 1, nodeId: 'nodeX', attempt: 1 })
    let dreamBrief = (texts) => texts.dreamBrief({ round: 1, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r001'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 3, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox: null } })

    it('guideText:只取條目(略去標題列與「>」說明列);依列截到上限;無檔或無條目回空字串', () => {
        assert.equal(guideText(t.dir, GUIDE.node), '')
        fs.writeFileSync(path.join(t.dir, GUIDE.node.rel), '# 標題\n\n> 說明\n\n', 'utf8')
        assert.equal(guideText(t.dir, GUIDE.node), '')
        fs.writeFileSync(path.join(t.dir, GUIDE.node.rel), `# 標題\n\n> 說明\n\n- 守則甲(r006)\n- 守則乙(r007)\n${Array.from({ length: 80 }, (_, i) => `- 填充 ${i} ${'字'.repeat(20)}`).join('\n')}\n`, 'utf8')
        let g = guideText(t.dir, GUIDE.node)
        assert(g.startsWith('- 守則甲(r006)\n- 守則乙(r007)') && !g.includes('標題') && !g.includes('說明'))
        assert(Buffer.byteLength(g, 'utf8') <= GUIDE.node.cap && g.split('\n').every((l) => l.startsWith('- ')), '截在整列之邊界')
        assert(Buffer.byteLength(guideText(t.dir, { ...GUIDE.node, cap: 1e9 }), 'utf8') > GUIDE.node.cap)
    })

    it('任務書:有條目時原文附於末並寫明「與上文牴觸時以上文為準」;做夢任務書另說明這類守則由它自己維護、不必列為改進項;關閉時皆不出現', () => {
        fs.writeFileSync(path.join(t.dir, GUIDE.node.rel), '# t\n\n- 節點守則甲(r006)\n', 'utf8')
        fs.writeFileSync(path.join(t.dir, GUIDE.dream.rel), '# t\n\n- 做夢守則甲(r006)\n', 'utf8')
        let on = makeTexts({ st, FD_ROOT: t.dir })
        let nb = nodeBrief(on)
        assert(nb.includes('## 補充守則') && nb.includes('與上文牴觸時以上文為準') && nb.includes('- 節點守則甲(r006)'))
        assert(nb.indexOf('- 節點守則甲') < nb.lastIndexOf('DONE '), '附於收尾指示之前')
        let db = dreamBrief(on)
        assert(db.includes('- 做夢守則甲(r006)') && db.includes(GUIDE.dream.rel) && db.includes(GUIDE.node.rel) && db.includes('不必列為改進項'))
        let off = makeTexts({ st: { ...st, rsi: { ...st.rsi, guides: false } }, FD_ROOT: t.dir })
        assert(!nodeBrief(off).includes('補充守則') && !dreamBrief(off).includes('做夢守則甲') && !dreamBrief(off).includes('不必列為改進項'))
        //無條目: 不出現該節
        fs.writeFileSync(path.join(t.dir, GUIDE.node.rel), '# t\n\n> 說明\n', 'utf8')
        assert(!nodeBrief(makeTexts({ st, FD_ROOT: t.dir })).includes('補充守則'))
    })
})
