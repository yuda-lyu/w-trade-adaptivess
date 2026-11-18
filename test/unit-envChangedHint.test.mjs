import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeTexts, ENV_CHANGED_HINT } from '../src/domain/texts.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//節點任務書之口徑提示: 做夢文件套用時記下評估環境之鍵(harness.applied.envKey); 其後鍵改變(帳本重建、評估器版本、研究用本金)⇒ 來源方向之全文之前列一句固定之提示
//  鍵未變、未記鍵之舊文件 ⇒ 不列(任務書逐字不變)
describe('節點任務書之口徑提示(評估環境之鍵於方向寫定後改變)', function () {
    this.timeout(60000)
    let t
    beforeEach(() => {
        t = makeTmp('envHint')
    })
    afterEach(() => {
        t.cleanup()
    })
    let arms = ['A01_nt', 'B14_pitKey']
    let spec = { arms, base: null }
    let mkSt = () => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.resources = {}
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        return st
    }
    let mkP = (st, key, dispatch = async () => ({ ok: false, error: '測試不派工' }), meta = {}) => {
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key, ...meta }), 'utf8')
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(t.dir, 'proj', 'catalog.json') })
        P.rsi.init()
        return P
    }
    let putDream = (P, applied) => P.records.putDreamDoc({
        round: 1,
        createdAt: '2026-11-14T00:00:00.000Z',
        agent: { model: 'm', durationSec: 1 },
        scope: { nodes: [] },
        audits: [],
        synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
        guidance: { directions: [{ type: 'explore', arms, base: null, rationale: '依據之全文 S 87.23', expect: '預期之全文' }], avoid: [], openQuestions: [], improvements: [] },
        docsUpdated: [],
        harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [{ arms, base: null, ok: true }], skipped: [], ...applied } },
    })

    it('任務書:帶 envChanged 者於方向之全文之前列提示(恰一次、固定文字不含數字);不帶者與未加本功能時之文字相同', () => {
        let st = mkSt()
        let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
        let wd = path.join(st.records.workDir, 'nodeX')
        let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let direction = { round: 3, doc: 'rsi/records/dreams/r003.md', rationale: '依據之全文', expect: '預期之全文' }
        let task = (d) => ({ goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: d, toolbox, trial: null })
        let brief = (d) => texts.nodeBrief({ workDir: wd, task: task(d), round: 7, nodeId: 'nodeX', attempt: 1 })
        let off = brief(direction)
        let on = brief({ ...direction, envChanged: true })
        assert.equal(on.split(ENV_CHANGED_HINT).length, 2, '恰列一次')
        assert(on.indexOf('本節點之來源方向') < on.indexOf(ENV_CHANGED_HINT) && on.indexOf(ENV_CHANGED_HINT) < on.indexOf('依據之全文'), '位於方向之標題之後、全文之前')
        assert.equal(off.includes(ENV_CHANGED_HINT), false)
        assert.equal(on.replace(`${ENV_CHANGED_HINT}\n\n`, ''), off, '差異只有該句')
        assert.equal(/[0-9]/.test(ENV_CHANGED_HINT), false, '固定文字不帶數字')
    })

    it('來源方向:鍵未變 ⇒ 不帶 envChanged;帳本鍵改變 ⇒ 帶;未記鍵之舊文件 ⇒ 不帶(無從判定)', () => {
        let st = mkSt()
        let P1 = mkP(st, 'keyA')
        putDream(P1, { envKey: P1.envKey })
        assert.equal('envChanged' in P1.taskFor(spec, 2).direction, false, '鍵未變')
        let P2 = mkP(st, 'keyB')
        assert.notEqual(P2.envKey, P1.envKey, '鍵確已改變(鑑別前提)')
        let d2 = P2.taskFor(spec, 2).direction
        assert.equal(d2.envChanged, true)
        assert.equal(d2.rationale, '依據之全文 S 87.23', '方向之全文不改寫')
        //未記鍵之舊文件
        putDream(P2, {})
        assert.equal('envChanged' in P2.taskFor(spec, 2).direction, false)
    })

    it('來源方向:研究用本金改變(帳本鍵不變)亦視為鍵改變', () => {
        let st = mkSt()
        let unit = (uIni) => ({ unit: { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.1, uIni } })
        let P1 = mkP(st, 'keyA', undefined, unit(10000))
        putDream(P1, { envKey: P1.envKey })
        assert.equal('envChanged' in P1.taskFor(spec, 2).direction, false)
        let P2 = mkP(st, 'keyA', undefined, unit(20000))
        assert.equal(P2.taskFor(spec, 2).direction.envChanged, true)
    })

    it('接線:輪末套用做夢時把現行之評估環境之鍵記入做夢文件之 harness.applied(既有之鍵照舊)', async () => {
        let st = mkSt()
        let dispatch = async (role, { prompt }) => {
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let dream = { audits: [], synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = mkP(st, 'keyA', dispatch)
        P.requestDreamOnly({ why: '只做夢' })
        let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
        assert(hk.dream, '做夢已套用(鑑別前提)')
        let ap = P.records.getDreamDoc(1).harness.applied
        assert.equal(ap.envKey, P.envKey)
        assert.deepEqual([ap.accepted, ap.rework, ap.deleted, ap.proposals, ap.skipped], [[], [], [], [], []])
    })

    //briefOf, 端到端: 輪末套用做夢(含一條方向)→ 視情境改鍵 → 以真流程(taskFor → arsi.runNode)產生節點任務書; 回 brief.md 之內容
    //  同一暫存路徑、同一節點 id(同為 keyB)之情境才可逐位比較
    let briefOf = async (scen) => {
        let d = path.join(t.dir, 'proj')
        fs.rmSync(d, { recursive: true, force: true })
        let st = mkSt()
        let dispatch = async (role, { prompt }) => {
            if (role !== 'dream') {
                return { ok: false, quota: true, error: '測試不派節點' }
            }
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let dream = { audits: [], synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [{ type: 'explore', arms, base: null, rationale: '依據之全文 S 87.23', expect: '預期之全文' }], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P1 = mkP(st, 'keyA', dispatch)
        P1.requestDreamOnly({ why: '只做夢' })
        let hk = await P1.domain.hooks.afterRound({ round: 1, nodes: [] })
        assert(hk.dream, '做夢已套用(鑑別前提)')
        if (scen === 'oldDoc') {
            let dd = P1.records.getDreamDoc(1)
            delete dd.harness.applied.envKey
            P1.records.putDreamDoc(dd)
        }
        let P2 = mkP(st, scen === 'same' ? 'keyA' : 'keyB', dispatch)
        let nodeId = P2.idOf(spec)
        await P2.arsi.runNode({ nodeId, spec, round: 2, task: P2.taskFor(spec, 2) }).catch(() => null)
        return fs.readFileSync(path.join(P2.arsi.nodeWorkDir(nodeId), 'brief.md'), 'utf8')
    }

    it('端到端(派工之任務書):鍵改變 ⇒ 提示句恰 1 次、位於方向之標題之後與全文之前;未記鍵之舊文件與之只差該句;鍵未變 ⇒ 不列', async () => {
        let changed = await briefOf('changed')
        assert.equal(changed.split(ENV_CHANGED_HINT).length, 2, '恰列一次')
        let iHead = changed.indexOf('本節點之來源方向')
        let iHint = changed.indexOf(ENV_CHANGED_HINT)
        let iFull = changed.indexOf('依據之全文 S 87.23')
        assert(iHead >= 0 && iHead < iHint && iHint < iFull, JSON.stringify([iHead, iHint, iFull]))
        let oldDoc = await briefOf('oldDoc')
        assert.equal(oldDoc.includes(ENV_CHANGED_HINT), false, '未記鍵之舊文件無從判定 ⇒ 不列')
        assert.equal(changed.replace(`${ENV_CHANGED_HINT}\n\n`, ''), oldDoc, '差異只有該句(同一節點 id、同一路徑)')
        let same = await briefOf('same')
        assert.equal(same.includes(ENV_CHANGED_HINT), false, '鍵未變 ⇒ 不列')
        assert(same.includes('依據之全文 S 87.23'), '方向之全文照帶(鑑別前提)')
    })
})
