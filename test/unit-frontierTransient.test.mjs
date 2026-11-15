import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { peekRound } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'

//額度造成之失敗不消耗前緣重試次數(規則 R-RUN-8⑦; Gitea #157; w-recursi 1.0.12 之約定: 評估器拋出之值帶 transient: true ⇒ 前緣結案不計 retries、另記 transients)
//  接縫不用替身: 真 w-recursi(createRsi → auto → explore → runJobs → 前緣結案)+ 本套件真實之領域(makeProject 之 evaluator.evaluate → arsi.runNode);
//  只有「派工」換成假的(inject.dispatch): 節點派工回 quota: true(額度用盡)或拋例外(一般失敗), 不耗任何模型額度、不起子行程、不需真實帳本(額度分支在重跑驗證之前即中止)
describe('額度造成之失敗不消耗前緣重試(R-RUN-8⑦, Gitea #157): 真 w-recursi + 真領域 + 假派工', function () {
    let ARMS = ['A01_nt', 'B14_pitKey']
    let t
    beforeEach(() => {
        t = makeTmp('frontierTransient')
    })
    afterEach(() => {
        t.cleanup()
    })

    //mk, 於暫存夾組裝專案(狀態根、紀錄、帳本識別皆在暫存夾), 並把一個方向入前緣(= 引擎之前緣提案); 回 { P, calls }
    let mk = (dispatchOf) => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
        let calls = { node: 0 }
        let dispatch = async (role) => {
            calls.node += role === 'node' ? 1 : 0
            return dispatchOf(calls.node)
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        let r = P.proposeDirection({ type: 'explore', arms: ARMS, base: null, rationale: '前緣提案' }, 1)
        assert.equal(r.ok, true, '方向須入前緣')
        return { P, calls }
    }
    let QUOTA = () => ({ ok: false, quota: true, error: 'fake: 額度用盡', agent: { kind: 'fake', model: 'fake-node' } })
    let PLAIN = () => {
        throw new Error('fake: 派工例外')
    }
    //run, 走一輪(引擎之 auto; 不做夢); 回該輪結果
    let run = (P) => P.rsi.auto({ by: 'test', protocol: { round: peekRound(P.rsi.paths) }, arms: 1, novelty: 1, workers: 1, noDream: true })
    let rowOf = (P) => P.rsi.store.listFrontier().find((f) => f.spec.arms.join('+') === ARMS.join('+'))

    it('額度用盡(節點派工回 quota: true)⇒ 前緣之該提案維持 proposed、retries 未增、transients 為 1;節點為 error 且帶 transient;摘要記 transient 而非 retried', async () => {
        let { P, calls } = mk(QUOTA)
        let res = await run(P)
        assert.equal(calls.node, 1)
        let row = rowOf(P)
        //spec(Gitea #157): 額度造成之失敗不再消耗前緣重試次數
        assert.deepEqual([row.status, row.transients, row.retries || 0], ['proposed', 1, 0])
        assert.equal(row.note, undefined, '不寫「評估錯誤」之 note(retries 路徑才寫)')
        assert.deepEqual([res.frontierRes.retried, res.frontierRes.blocked, res.frontierRes.transient], [0, 0, 1])
        let n = res.nodes.find((x) => x.spec.arms.join('+') === ARMS.join('+'))
        assert.deepEqual([n.status, n.notes.transient], ['error', true])
        assert(/額度用盡而未完成/.test(n.notes.error), '節點之錯誤文字仍留額度用盡之說明')
    })

    it('連續多輪額度用盡(超過 maxRetries 預設 2)⇒ 提案仍為 proposed、不被封存(blocked);transients 逐輪加一;每輪皆重新派工', async () => {
        let { P, calls } = mk(QUOTA)
        for (let k = 1; k <= 4; k++) {
            let res = await run(P)
            let row = rowOf(P)
            assert.deepEqual([row.status, row.transients, row.retries || 0, calls.node], ['proposed', k, 0, k], `第 ${k} 輪`)
            assert.deepEqual([res.frontierRes.retried, res.frontierRes.blocked, res.frontierRes.transient], [0, 0, 1], `第 ${k} 輪之摘要`)
        }
    })

    it('一般失敗(派工拋例外、無 transient)⇒ 照舊計 retries:第 1 輪 retries 1 仍 proposed、第 2 輪達 maxRetries 2 而 blocked;不記 transients', async () => {
        let { P } = mk(PLAIN)
        let res1 = await run(P)
        let row = rowOf(P)
        assert.deepEqual([row.status, row.retries, row.transients], ['proposed', 1, undefined])
        assert.deepEqual([res1.frontierRes.retried, res1.frontierRes.blocked, res1.frontierRes.transient], [1, 0, undefined])
        let n = res1.nodes.find((x) => x.spec.arms.join('+') === ARMS.join('+'))
        assert.deepEqual([n.status, n.notes.transient], ['error', undefined])
        let res2 = await run(P)
        row = rowOf(P)
        assert.deepEqual([row.status, row.retries, row.transients], ['blocked', 2, undefined])
        assert.deepEqual([res2.frontierRes.retried, res2.frontierRes.blocked], [0, 1])
    })

    it('額度失敗與一般失敗交錯 ⇒ 兩個計數各記各的:額度 transients、一般 retries;只有一般失敗達上限才封存', async () => {
        //第 1 輪額度、第 2 輪一般、第 3 輪額度、第 4 輪一般
        let { P } = mk((k) => (k % 2 === 1 ? QUOTA() : PLAIN()))
        await run(P)
        let row = rowOf(P)
        assert.deepEqual([row.status, row.transients, row.retries || 0], ['proposed', 1, 0], '第 1 輪(額度)')
        await run(P)
        row = rowOf(P)
        assert.deepEqual([row.status, row.transients, row.retries], ['proposed', 1, 1], '第 2 輪(一般)')
        await run(P)
        row = rowOf(P)
        assert.deepEqual([row.status, row.transients, row.retries], ['proposed', 2, 1], '第 3 輪(額度)')
        await run(P)
        row = rowOf(P)
        assert.deepEqual([row.status, row.transients, row.retries], ['blocked', 2, 2], '第 4 輪(一般達 maxRetries 2)')
    })
})
