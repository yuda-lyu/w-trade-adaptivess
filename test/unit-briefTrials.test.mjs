import assert from 'assert/strict'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { TRIALS, activeTrial, assignTrial, variantFallback, clauseOn } from '../src/domain/briefTrials.mjs'


//任務書條款之隨機對照(src/domain/briefTrials.mjs; 監控原則 §1 第 8 點; 規則 R-MON-2): 分組須平衡、與內容無關、可重現; 條款依組別分支
describe('briefTrials:任務書條款之隨機對照', function () {
    let ids = ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444', 'eeee5555']

    it('activeTrial:只取進行中且已到起始輪次者;一次一個', () => {
        let trials = [{ id: 'X1', status: 'adopted', since: 1 }, { id: 'X2', status: 'open', since: 5 }, { id: 'X3', status: 'dropped', since: 1 }]
        assert.strictEqual(activeTrial(4, trials), null)
        assert.equal(activeTrial(5, trials).id, 'X2')
        assert.strictEqual(activeTrial(null, trials), null, '不知輪次(重做、驗證時之呼叫)不指派')
        assert(TRIALS.filter((t) => t.status === 'open').length <= 1, '一次只開一個試驗')
        for (let t of TRIALS) {
            assert(t.id && t.title && t.metric && Number.isInteger(t.since), `試驗 ${t.id} 須寫明條款、事先定之指標與起始輪次`)
        }
    })

    it('assignTrial:依任務類型分層後交替指派 ⇒ 每層兩組人數差 ≤ 1;同輸入同結果;換輪次則各層之首位對調', () => {
        let items = [...ids.slice(0, 3).map((id) => ({ id, type: 'explore' })), ...ids.slice(3).map((id) => ({ id, type: 'verify' }))]
        let m = assignTrial('X', 9, items)
        assert.equal(m.size, 5)
        for (let ty of ['explore', 'verify']) {
            let vs = items.filter((x) => x.type === ty).map((x) => m.get(x.id))
            assert(Math.abs(vs.filter((v) => v === 'A').length - vs.filter((v) => v === 'B').length) <= 1, `${ty} 層不平衡: ${vs.join('')}`)
        }
        assert.deepEqual([...assignTrial('X', 9, items.slice().reverse())].sort(), [...m].sort(), '與輸入之順序無關')
        let m2 = assignTrial('X', 10, items)
        assert(ids.every((id) => m2.get(id) !== m.get(id)), '下一輪各節點之組別對調(多出之一席輪流落在兩組)')
        //未給 type 者視為探索
        assert.equal(assignTrial('X', 9, ids.map((id) => ({ id }))).size, 5)
    })

    it('variantFallback:讀不到該輪之計畫時依雜湊之奇偶(可重現)', () => {
        assert(['A', 'B'].includes(variantFallback('X', 'n1')))
        assert.equal(variantFallback('X', 'n1'), variantFallback('X', 'n1'))
    })

    it('clauseOn:進行中只對 B 組生效;已採納對全體生效;已撤回或不存在皆不生效', () => {
        let trials = [{ id: 'O', status: 'open' }, { id: 'Y', status: 'adopted' }, { id: 'N', status: 'dropped' }]
        assert.equal(clauseOn('O', { id: 'O', variant: 'B' }, trials), true)
        assert.equal(clauseOn('O', { id: 'O', variant: 'A' }, trials), false)
        assert.equal(clauseOn('O', null, trials), false)
        assert.equal(clauseOn('O', { id: 'Z', variant: 'B' }, trials), false, '別的試驗之 B 組不算')
        assert.equal(clauseOn('Y', null, trials), true)
        assert.equal(clauseOn('N', { id: 'N', variant: 'B' }, trials), false)
        assert.equal(clauseOn('none', { id: 'none', variant: 'B' }, trials), false)
    })

    it('T1(已採納;無進行中之試驗):同一內容不重跑完整評估、重疊率以 quick --ref 量 —— 探索類每個版本一個檔、最後複製選定者;驗證類交付版一開始就寫成 pick.mjs;任務書不逾 15,000 位元組', () => {
        let st = getSettings()
        let texts = makeTexts({ st: { ...st, rsi: { ...st.rsi, guides: false } }, FD_ROOT: st.FD_ROOT })
        let wd = path.join(st.records.workDir, 'nodeX')
        let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
        let task = (o = {}) => ({ goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox: { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }, ...o })
        let brief = (t) => texts.nodeBrief({ workDir: wd, task: t, round: 9, nodeId: 'nodeX', attempt: 1 })
        assert.equal(TRIALS.find((t) => t.id === 'T1').status, 'adopted')
        assert.equal(TRIALS.filter((t) => t.status === 'open').length, 0)
        //探索類: 依回測期之結果迭代 ⇒ 每個版本一個檔(評估過之檔不改寫), 最後把選定者與其結果檔複製成 pick.mjs / result_full.json
        let e = brief(task())
        assert(e.includes('每個版本另存 `try_<版本名>.mjs`') && e.includes('**同一內容不要完整評估兩次**') && e.includes('把選定之實驗檔**複製**成 `pick.mjs`') && e.includes('**內容相同就不必重跑**'))
        assert(!e.includes('一開始就寫成 `pick.mjs`'), '探索類不要求先定交付版之檔名(否則迭代後改交即須改寫已評估之檔)')
        assert(e.includes('--mode quick --ref') && !e.includes('base_pick.mjs'), '無起點者之範例指令不含 base_pick.mjs')
        assert(brief(task({ base: { nodeId: 'b1', S: -3.2, ladder: 0, doc: 'rsi/records/nodes/b1.md' } })).includes(',rsi/work/nodeX/base_pick.mjs'))
        //驗證類: 設計由方向定死 ⇒ 交付版一開始就寫成 pick.mjs; 重疊率不另跑完整評估
        let v = brief(task({ type: 'verify', claim: '主張甲' }))
        assert(v.includes('**交付版一開始就寫成 `pick.mjs`**') && v.includes('**已跑過就不必再跑**') && v.includes('重疊率以 `--mode quick --ref') && v.includes('`quick_ref.json`') && !v.includes('`full_ref.json`'))
        //試驗組別不影響已採納之條款; 共通之條款(迴圈之機械檢查依此字樣)與大小
        for (let t of [task(), task({ trial: { id: 'T1', variant: 'A' } }), task({ type: 'verify', claim: '主張甲' })]) {
            let s = brief(t)
            assert(s.includes('**先寫規劃再評估**') && s.includes('**一實驗一檔**') && s.includes('**評估過之檔不再改寫**'))
            assert(Buffer.byteLength(s, 'utf8') <= 15000, `任務書 ${Buffer.byteLength(s, 'utf8')} 位元組`)
        }
        assert.equal(brief(task({ trial: { id: 'T1', variant: 'A' } })), brief(task()))
    })

    it('做夢任務書:本輪有試驗時列出兩組之節點,並說明審計依各節點自己的任務書;無試驗者不出現', () => {
        let st = getSettings()
        let texts = makeTexts({ st: { ...st, rsi: { ...st.rsi, guides: false } }, FD_ROOT: st.FD_ROOT })
        let node = (id, trial) => ({ nodeId: id, arms: ['A04_act'], base: null, S: 1, excess: 0, ladder: 0, backtest: 'level', vetoed: true, claimedS: 1, nEvals: 3, issues: [], from: null, type: 'explore', trial, docMd: 'd.md', workDir: `rsi/work/${id}` })
        let ctx = (nodes) => ({ round: 9, nodeIds: nodes.map((n) => n.nodeId), reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r009'), context: { nodes, failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox: null } })
        let s = texts.dreamBrief(ctx([node('n1aaaaaaaa', { id: 'T1', variant: 'A' }), node('n2bbbbbbbb', { id: 'T1', variant: 'B' })]))
        assert(s.includes('**任務書條款之試驗 T1**') && s.includes('B 組(`n2bbbbbb`)') && s.includes('A 組(`n1aaaaaa`)') && s.includes('**審計依各節點自己的任務書'))
        assert(!texts.dreamBrief(ctx([node('n1aaaaaaaa', null)])).includes('任務書條款之試驗'))
    })
})
