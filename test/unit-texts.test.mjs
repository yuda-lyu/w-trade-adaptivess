import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { outwardNoteOf, prevDirectionOf, OUT_CHECK_MIN } from '../src/domain/domain.mjs'
import { renderContract } from '../src/tools/initProject.mjs'
import { FD_ROOT } from './tools/synthLedger.mjs'


//任務書文字(src/domain/texts.mjs): 任務類型決定節點之做法要求(R-REC-8); 共用工具區之指引(R-TB-3); 做夢之擴建一節(R-TB-2); 節點任務書之大小(處理要點 §7: 逾 15 KB 即整併)
describe('texts:任務類型與共用工具區', function () {
    //寫法守則(做夢維護之檔; R-MON-3)之內容會隨輪次變動 ⇒ 本組測試關閉之(st.rsi.guides = false), 另以暫存根測其附入與截斷
    let st0 = getSettings()
    let st = { ...st0, rsi: { ...st0.rsi, guides: false } }
    let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
    let wd = path.join(st.records.workDir, 'nodeX')
    let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
    let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
    let task = (o = {}) => ({ goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox, ...o })
    let brief = (t) => texts.nodeBrief({ workDir: wd, task: t, round: 7, nodeId: 'nodeX', attempt: 1 })

    it('目標與期間:節點與做夢之目標 = 回測期之等效年化更佳;評估器預設評估回測期;訓練期之績效不是目標;不得把回測期之答案寫進模組', () => {
        //節點可直接跑回測期回測; 訓練期之資訊已濃縮在策略庫
        let s = brief(task())
        assert(s.includes('**目標:使回測期(2025-10-06 ~ 2026-07-31)之等效年化報酬更佳'))
        assert(s.includes('**評估器預設評估回測期**') && s.includes('`--period train`') && s.includes('**訓練期之績效不是目標**'))
        assert(s.includes('**防偶然**') && s.includes('平原上的一點'))
        assert(s.includes('不得把回測期之答案寫進模組') && s.includes('`tmp/`') && s.includes('`--seed`'))
        //保留期與其他標的只在「共同儲存區」之說明內出現(由主控檢定, 只把正負號給節點與做夢; 規則 R-BT-4、R-REC-30); 其餘各處仍不提保留期與其他標的;
        //  其他標的之名稱(他幣、標的代號)一律不出現; 其數字不出現(任務書不讀 _cross.json 之內容, 見下方 R-REC-30 之案)
        let noStore = (x) => x.split('\n').filter((l) => !l.includes('共同儲存')).join('\n')
        assert(!/旗標|樣本外|above|mixed|保留期|其他標的|BTC/.test(noStore(s)), '共同儲存區之說明以外, 任務書不得出現檢定旗標之等級用語, 亦不提保留期與其他標的')
        assert(!/BTC|他幣/.test(s))
        let d = texts.dreamBrief({ round: 1, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r001'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 4, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
        assert(d.includes('**你與節點共同之目標:找出自適應挑選策略,使回測期(2025-10-06 ~ 2026-07-31)之等效年化報酬更佳'))
        assert(d.includes('| 回測期 S / 最差相位 / 對隨機之超額 / 階梯 |') && d.includes('| **-12.3** / -30.1 / 8.2 / 0 |'))
        assert(d.includes('**審偶然**') && d.includes('**以回測期之績效為準**'))
        assert(!/回測期旗標|樣本外|保留期|其他標的|BTC/.test(noStore(d)))
        assert(!/BTC|他幣/.test(d))
    })

    it('共同儲存區(R-REC-25)與保留期之正負號(R-BT-4):已有總表時兩份任務書指向它並寫明只有正負號;尚無總表時不提', () => {
        //節點與做夢皆能查閱全部已找到之挑選策略; 保留期之數字不給, 只給正負號
        let FD_ROOT = st.FD_ROOT
        let mk = (root) => makeTexts({ st: { ...st, rsi: { ...st.rsi, root } }, FD_ROOT })
        let dctx = { round: 1, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r001'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '', toolbox } }
        let nb = (tx) => tx.nodeBrief({ workDir: wd, task: task(), round: 7, nodeId: 'nodeX', attempt: 1 })
        let root0 = path.join(FD_ROOT, 'test', '_tmp', `texts_store_${process.pid}`)
        fs.mkdirSync(path.join(root0, 'picks'), { recursive: true })
        try {
            let t0 = mk(root0)
            assert(!nb(t0).includes('共同儲存') && !t0.dreamBrief(dctx).includes('共同儲存'), '尚無總表 ⇒ 不提')
            fs.writeFileSync(path.join(root0, 'picks', 'INDEX.md'), '# 總表\n', 'utf8')
            let t1 = mk(root0)
            let s1 = nb(t1)
            let d1 = t1.dreamBrief(dctx)
            assert(s1.includes('**動手前先看共同儲存區之總表**') && s1.includes('**保留期之正負號**') && s1.includes('只有正負號,數字不提供') && s1.includes('不讀其工作夾'))
            assert(d1.includes('**共同儲存「自適應挑選策略」區**') && d1.includes('**只提供正負號**') && d1.includes('不以單一成品之正負號下結論'))
            assert(Buffer.byteLength(s1) <= 15000, `節點任務書 ${Buffer.byteLength(s1)} 位元組`)
        }
        finally {
            fs.rmSync(root0, { recursive: true, force: true })
        }
    })

    it('其他標的之正負號(R-REC-30):共同儲存區有 _cross.json 時兩份任務書各插一段固定之說明(只有正負號);無此檔或無總表時不提;只依檔之有無、不讀其內容 ⇒ 任務書不出現任何號、數字、期間或其他標的之名稱;與無此檔時之差只在所插入之文字', () => {
        let FD_ROOT = st.FD_ROOT
        let mk = (root) => makeTexts({ st: { ...st, rsi: { ...st.rsi, root } }, FD_ROOT })
        let dctx = { round: 1, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r001'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '', toolbox } }
        let nb = (tx) => tx.nodeBrief({ workDir: wd, task: task(), round: 7, nodeId: 'nodeX', attempt: 1 })
        let root0 = path.join(FD_ROOT, 'test', '_tmp', `texts_cross_${process.pid}`)
        fs.mkdirSync(path.join(root0, 'picks'), { recursive: true })
        //檔之內容含數字、號、期間與標的代號: 任務書只依檔之有無, 不讀內容
        let crossText = JSON.stringify({ note: '標的 QQXYZ 3141.5', items: { n1: { backtest: { perf: '+', content: 4242.6 }, holdout: { perf: '-', content: '-5353.7' } } }, period: '2031-04-05 ~ 2032-06-07' })
        let NODE_INS = '、**其他標的之正負號**(同一挑選模組原樣不改、於另一標的之策略庫上評估;回測期與保留期各一;只有正負號,數字不提供;讀法同保留期)'
        let DREAM_INS = '總表另列**其他標的之正負號**(`cross` 欄:同一挑選模組原樣不改、於另一標的之策略庫上評估;回測期與保留期各給績效與挑選內容之號;同樣由主控執行、**只提供正負號**,新節點之正負號於下一輪補入):用於大致判斷一條線換一個標的是否仍成立(機制是否只屬本標的);讀法與限制同保留期之正負號。'
        try {
            //只有 _cross.json、尚無總表 ⇒ 不提(共同儲存區未產生)
            fs.writeFileSync(path.join(root0, 'picks', '_cross.json'), crossText, 'utf8')
            let t0 = mk(root0)
            assert(!nb(t0).includes('其他標的') && !t0.dreamBrief(dctx).includes('其他標的'))
            fs.rmSync(path.join(root0, 'picks', '_cross.json'))
            //有總表而無 _cross.json ⇒ 不提
            fs.writeFileSync(path.join(root0, 'picks', 'INDEX.md'), '# 總表\n', 'utf8')
            let t1 = mk(root0)
            let s1 = nb(t1)
            let d1 = t1.dreamBrief(dctx)
            assert(!s1.includes('其他標的') && !d1.includes('其他標的'))
            //兩者皆有 ⇒ 兩份任務書皆說明, 差只在所插入之文字
            fs.writeFileSync(path.join(root0, 'picks', '_cross.json'), crossText, 'utf8')
            let t2 = mk(root0)
            let s2 = nb(t2)
            let d2 = t2.dreamBrief(dctx)
            assert(s2.includes(NODE_INS) && d2.includes(DREAM_INS))
            assert.equal(s2.indexOf(NODE_INS), s2.lastIndexOf(NODE_INS), '節點任務書只插一次')
            assert.equal(d2.indexOf(DREAM_INS), d2.lastIndexOf(DREAM_INS), '做夢任務書只插一次')
            assert.equal(s2.replace(NODE_INS, ''), s1, '節點任務書之差只在所插入之文字')
            assert.equal(d2.replace(DREAM_INS, ''), d1, '做夢任務書之差只在所插入之文字')
            //所插入之文字不含任何數字、號之字面與期間(只說明欄之意義與讀法)
            for (let ins of [NODE_INS, DREAM_INS]) {
                assert(!/[0-9]/.test(ins), '插入之文字不含數字')
            }
            for (let x of [s2, d2]) {
                assert(!/QQXYZ|3141|4242|5353|2031|2032|他幣/.test(x), '不讀檔之內容、不寫其他標的之名稱、數字與期間(標的代號之檢查見「目標與期間」一案)')
                assert(!/其他標的/.test(x.split('\n').filter((l) => !l.includes('共同儲存')).join('\n')), '只在共同儲存區之說明內')
            }
            assert(Buffer.byteLength(s2) <= 15000, `節點任務書 ${Buffer.byteLength(s2)} 位元組`)
            //只依檔之有無: 檔之內容換成非 JSON、空檔、形狀不合者, 兩份任務書逐字不變
            for (let other of ['{ not json', '', '[]', '{"items":"x"}', JSON.stringify({ items: { n1: { backtest: { perf: '0' } } } })]) {
                fs.writeFileSync(path.join(root0, 'picks', '_cross.json'), other, 'utf8')
                let t3 = mk(root0)
                assert.equal(nb(t3), s2, `內容 ${JSON.stringify(other)}`)
                assert.equal(t3.dreamBrief(dctx), d2, `內容 ${JSON.stringify(other)}`)
            }
        }
        finally {
            fs.rmSync(root0, { recursive: true, force: true })
        }
    })

    it('臂目錄之提案(R-ARM-1):節點與做夢之任務書皆明寫可提新臂 / 新層 / 修訂 / 停用;範本有此欄;節點之提案列於做夢任務書', () => {
        //任務書未明寫可提新臂即等於限制 rsi 之探索範疇
        let s = brief(task())
        assert(s.includes('`conclusion.armProposals`') && s.includes('**臂目錄不是封閉的**') && s.includes('`new`(新臂)') && s.includes('`layer`(新的一層') && s.includes('`revise`') && s.includes('`retire`') && s.includes('提案不影響本節點之任務'))
        assert.deepEqual(texts.nodeTemplate({ workDir: wd, task: task() }).conclusion.armProposals, [])
        let ctx = (extra) => ({ round: 2, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r002'), context: { nodes: [{ nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox, ...extra } })
        let d = texts.dreamBrief(ctx({ armProposals: { ledger: 'rsi/governance/PROPOSALS.md', fromNodes: [{ nodeId: 'n1aaaaaaaaaaaaaa', kind: 'new', layer: 'A', title: '進場價位風格', mechanism: '依進場當下之價位位置分類' }] } }))
        assert(d.includes('`guidance.armProposals`') && d.includes('**不是封閉的**') && d.includes('`rsi/governance/PROPOSALS.md`') && d.includes('**主控(迴圈之維護者)審查,通過者於下一輪加入目錄**'))
        assert(d.includes('**方向之 `arms` 仍須為目錄內之可選臂**') && d.includes('本輪節點之提案') && d.includes('`n1aaaaaa` 〔新臂〕進場價位風格'))
        assert(d.includes('**臂目錄本身之增、修、停用**(另寫在下述之 `guidance.armProposals`)'), '改進項之說明把臂目錄之提案導向專欄')
        assert(!texts.dreamBrief(ctx({})).includes('本輪節點之提案'), '無節點提案時不列該行')
        assert(!texts.dreamBrief(ctx({ armProposals: { ledger: null, fromNodes: [] } })).includes('提案與處置之帳在'), '尚無提案帳(引擎之治理未建)時不列帳之路徑')
        assert.deepEqual(texts.dreamTemplate(ctx({})).guidance.armProposals, [])
    })

    it('主張之判定:驗證類節點另填 claimVerdict / claimNote;做夢範本之前次方向以節點之自判預填', () => {
        let dir = { round: 6, doc: 'rsi/records/dreams/r006.md', rationale: '依據乙', expect: '預期丙', type: 'verify', claim: '主張甲' }
        let sv = brief(task({ type: 'verify', claim: '主張甲', direction: dir }))
        assert(sv.includes('**填 `claimVerdict`**') && sv.includes('`claimNote`'))
        assert(brief(task()).includes('來源方向寫有判定方式') && !brief(task()).includes('**填 `claimVerdict`**'))
        let tv = texts.nodeTemplate({ workDir: wd, task: task({ type: 'verify', claim: '主張甲', direction: dir }) }).conclusion
        assert(typeof tv.claimVerdict === 'string' && typeof tv.claimNote === 'string')
        assert(!('claimVerdict' in texts.nodeTemplate({ workDir: wd, task: task() }).conclusion), '探索類之範本不預列此鍵')
        //驗證類之結論即主張之判定 —— 任務書寫明不填 outcome、範本無此欄; 探索類之範本仍有
        assert(sv.includes('**不填 `outcome`**') && !('outcome' in tv), '驗證類不要求 outcome')
        assert('outcome' in texts.nodeTemplate({ workDir: wd, task: task() }).conclusion, '探索類之範本仍列 outcome')
        let node = (o) => ({ nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], type: 'verify', docMd: 'd.md', workDir: 'rsi/work/n1', ...o })
        let tpl = (nodes) => texts.dreamTemplate({ round: 7, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r007'), context: { nodes, failed: [], refs: [], prevDirections: [{ round: 6, arms: ['B14_pitKey', 'A04_act'], base: null }, { round: 6, arms: ['D27_dedup'], base: null }], maxDirections: 7, extra: '', toolbox } }).synthesis.prevDirections
        let p = tpl([node({ from: { round: 6, arms: ['A04_act', 'B14_pitKey'], base: null }, claimVerdict: 'refuted', claimNote: '判定 ② 差 0.04' })])
        assert.equal(p[0].verdict, 'refuted')
        assert(p[0].note.includes('節點 n1aaaaaa 自判 refuted: 判定 ② 差 0.04') && p[0].note.includes('要改判者說明原因'))
        assert(/擇一/.test(p[1].verdict) && p[1].note === '(對應之節點與依據)', '無對應節點或節點未自判者維持原預填')
        assert(/擇一/.test(tpl([node({ from: { round: 6, arms: ['A04_act', 'B14_pitKey'], base: null }, claimVerdict: null })])[0].verdict))
    })

    it('有起點之探索類(R-REC-19):方向未指定對照時,去臂對照 = 起點成品之逐位複本;新加之臂皆屬取法 / 執行層者另註判讀方式', () => {
        //D / E 層之臂在中性底上無從識別 ⇒ 補位載體以現有最佳成品為底, 對照即起點
        let armE = { id: 'E38_maxHoldN', layer: 'E', layerName: 'E 執行', title: '同時持倉上限', desc: 'accept 以 book.open 限制', grid: null }
        let armB = { id: 'B14_pitKey', layer: 'B', layerName: 'B 排序鍵', title: '走勢前向排序鍵', desc: '近窗績效', grid: null }
        let base = { nodeId: 'base000011112222', arms: ['A04_act'], S: 12.3, ladder: 1, backtest: null, doc: 'rsi/records/nodes/base000011112222.md' }
        let sE = brief(task({ arms: [arm, armE], base }))
        assert(sE.includes('`control.mjs` = **起點成品之逐位複本**') && sE.includes('base_pick.mjs') && sE.includes('新加之臂屬取法 / 執行層(E38_maxHoldN)') && sE.includes('不同規則之間不直接比 S'))
        assert(!sE.includes('只把指定臂換成中性預設'), '有起點者不再要求中性去臂對照')
        let sB = brief(task({ arms: [arm, armB], base }))
        assert(sB.includes('`control.mjs` = **起點成品之逐位複本**') && !sB.includes('新加之臂屬取法 / 執行層'), '新加之臂非 D / E 層者不加判讀註記')
        let s0 = brief(task())
        assert(s0.includes('只把指定臂換成中性預設') && !s0.includes('起點成品之逐位複本'), '無起點者照舊')
    })

    it('未作用之臂(R-REC-20):節點任務書要求填 code.inactiveArms、範本有此欄;起點有未作用之臂者任務書註明;做夢任務書要求定案、範本以節點自報預填', () => {
        //指派之臂經實測後於交付版關閉者(例: 週末閘實測為負而關閉), 其節點之分數不是該臂之成績
        let s = brief(task())
        assert(s.includes('`code.inactiveArms`') && s.includes('**交付版未作用者**') && s.includes('只計作用中之臂'))
        assert.deepEqual(texts.nodeTemplate({ workDir: wd, task: task() }).code.inactiveArms, [])
        let base = { nodeId: 'base000011112222', arms: ['A04_act', 'E39_skipWeekend'], inactiveArms: ['E39_skipWeekend'], S: 12.3, ladder: 1, backtest: null, doc: 'rsi/records/nodes/base000011112222.md' }
        assert(brief(task({ base })).includes('起點所指派之臂中 E39_skipWeekend 於其交付版未作用'))
        assert(!brief(task({ base: { ...base, inactiveArms: [] } })).includes('於其交付版未作用'), '起點無未作用之臂者不加註')
        let node = (o) => ({ nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act', 'E39_skipWeekend'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1', ...o })
        let ctx = (nodes) => ({ round: 2, nodeIds: ['n1aaaaaaaaaaaaaa'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r002'), context: { nodes, failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
        let d = texts.dreamBrief(ctx([node({ inactiveArms: ['E39_skipWeekend'] })]))
        assert(d.includes('**定未作用之臂** `inactiveArms`') && d.includes('範本已預填節點自報者'))
        assert.deepEqual(texts.dreamTemplate(ctx([node({ inactiveArms: ['E39_skipWeekend'] })])).audits[0].inactiveArms, ['E39_skipWeekend'])
        assert.deepEqual(texts.dreamTemplate(ctx([node({})])).audits[0].inactiveArms, [], '節點未自報者預填空陣列')
    })

    it('探索類:任務類型之說明、可試 3 ~ 12 個變體、去臂對照', () => {
        let s = brief(task())
        assert(s.includes('**任務類型:探索**'))
        assert(s.includes('**依回測期之結果迭代,但每一步都要有理由**(完整評估 3 ~ 12 次'))
        assert(s.includes('**去臂對照**'))
        assert(s.includes('**來源方向已指定對照版者,`control.mjs` 即該對照**') && s.indexOf('來源方向已指定對照版者') < s.indexOf('只把指定臂換成中性預設'), '方向所指之對照優先於通則之去臂對照(例: 方向指定同種子對照, 節點卻另交全體隨機)')
        assert(!s.includes('只做方向指明之版本與對照'))
    })

    it('驗證類:列出待驗之主張;做法改為「只做方向指明之版本與對照」、不做變體搜尋;結論之首句三點', () => {
        let s = brief(task({ type: 'verify', claim: '主張甲', direction: { round: 6, doc: 'rsi/records/dreams/r006.md', rationale: '依據乙', expect: '預期丙', type: 'verify', claim: '主張甲' } }))
        assert(s.includes('**任務類型:驗證**'))
        assert(s.includes('- **待驗之主張**:主張甲'))
        assert(s.indexOf('待驗之主張') < s.indexOf('- **依據**:依據乙'))
        assert(s.includes('**只做方向指明之版本與對照**'))
        assert(s.includes('③回測期之結果依方向所寫之判定方式,主張是否成立'))
        assert(!s.includes('依回測期之結果迭代,但每一步都要有理由'), '驗證類不給變體搜尋之條款')
        assert(s.includes('以來源方向所指之成品為底') && !s.includes('比較對象是同劑量虛無'), '驗證類而無起點者: 比較對象為方向所指之對照, 不是隨機挑')
        assert(s.includes('**先寫規劃再評估**') && s.includes('**一實驗一檔**'), '兩類共通之條款仍在(迴圈之機械檢查依此字樣判斷任務書有無此要求)')
    })

    it('共用工具區:任務書指向索引、要求自報可共用、列為可讀而不可改;範本含 code.shareable;未啟用者皆不出現', () => {
        let s = brief(task())
        assert(s.includes('`rsi/toolbox/README.md`:**共用工具索引**') && s.includes('現有 3 個'))
        assert(s.includes('`code.shareable`'))
        assert(s.includes('、共用工具區 與其他任何檔') && s.includes('共用工具區 `rsi/toolbox/`'))
        //Gitea #154:「不得改」之程式夾由任務書程式之所在推得(套件夾內為 src/, 安裝於專案後為 node_modules/w-trade-adaptivess/src/); 不寫死舊配置之夾名 lib/
        assert(/不得改 `(?:node_modules\/w-trade-adaptivess\/)?src\/`、`g_\*\.mjs`/.test(s) && !s.includes('`lib/`'), '節點任務書之「不得改」')
        //「讀過評估器或迴圈之其他原始碼」一句所指之夾亦由所在推得(安裝後不在 src/ 而在 node_modules 內)
        assert(/`g_eval\.mjs`、`(?:node_modules\/w-trade-adaptivess\/)?src\/eval\/`、`(?:node_modules\/w-trade-adaptivess\/)?src\/arsi\/`/.test(s), '節點任務書之原始碼夾')
        assert(Array.isArray(texts.nodeTemplate({ workDir: wd, task: task() }).code.shareable))
        let off = brief(task({ toolbox: null }))
        assert(!off.includes('共用工具') && !off.includes('code.shareable'))
        assert.equal(texts.nodeTemplate({ workDir: wd, task: task({ toolbox: null }) }).code.shareable, undefined)
    })

    it('節點任務書(不含來源方向之全文)不逾 15,000 位元組', () => {
        for (let t of [task(), task({ type: 'verify', claim: '主張甲' })]) {
            let n = Buffer.byteLength(brief(t), 'utf8')
            assert(n <= 15000, `任務書 ${n} 位元組`)
        }
    })

    it('做夢任務書:方向須給 type(verify 另給 claim);有共用工具區時列「擴建」一節與節點自報之清單,其後之節號順延;範本含 expansion', () => {
        let ctx = (tb) => ({ round: 7, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r007'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, excess: 0, ladder: 0, backtest: 'level', vetoed: true, claimedS: 1, nEvals: 3, issues: [], from: null, type: 'verify', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox: tb } })
        let s = texts.dreamBrief(ctx({ ...toolbox, shareable: [{ nodeId: 'n1aaaaaaaaaa', file: 'seat.mjs', what: '依側配席' }] }))
        assert(s.includes('| 節點 | 臂 | 起點 | 類型 |') && s.includes('| 無 | 驗證 |'))
        assert(s.includes('| 3 | 無異常 |'), '無相異版本數之舊節點文件: 評估次數照舊只列總數')
        let c2 = ctx(toolbox)
        c2.context.nodes[0] = { ...c2.context.nodes[0], nEvals: 5, nFull: 4, nFullSel: 2 }
        assert(texts.dreamBrief(c2).includes('| 5(完整 4、相異選集 2) |'), '評估次數旁列完整評估之相異選集數')
        assert(s.includes('`type`(任務類型') && s.includes('`verify` 須另給 `claim`'))
        assert(s.includes('**配比:向內深掘與向外探勘並行**') && s.includes('**每輪至少 1 條向外**'), '方向之配比原則(監控原則 D5)')
        //可選臂全數試過後, 「向外」另認無起點而押新家族之探索(否則「每輪至少 1 條向外」無法滿足); 去重之說明含驗證類之主張(規則 R-REC-24)
        assert(s.includes('押新家族(`newFamily: true`') && s.includes('可選之臂皆已試過時,向外即指後者'), '向外之定義含押新家族之從零探索')
        assert(s.includes('**驗證類:去重另含主張**'), '驗證類方向之去重說明')
        //Gitea #154: 探索類與既有節點同臂同起點 ⇒ 不再略過, 規格另帶區分用之鍵後入前緣(domain.mjs 之 proposeDirection); 任務書同步說明, 並勸寬臂另提新臂
        assert(s.includes('另帶一個區分用之鍵') && s.includes('依據文字完全相同者(同一探索之重提)才略過') && s.includes('宜另提新臂(`guidance.armProposals`)') && !s.includes('同起點之節點若已存在會被略過'), '探索類方向之去重說明')
        //仍會略過之情形亦須寫明(無依據文字者、樹上尚無同規格之節點而前緣已有同臂同起點之待執行提案者): 否則做夢以為「只有依據相同才略過」
        assert(s.includes('無依據文字者、或樹上尚無同規格之節點而前緣內已有同臂同起點之待執行提案者,仍會被略過'), '探索類方向仍略過之情形')
        //禁止段與共用工具區之診斷腳本一條: 程式夾由所在推得; 暫存檔放自己之工作夾
        assert(/不得改 `(?:node_modules\/w-trade-adaptivess\/)?src\/`、`g_\*\.mjs`/.test(s) && !s.includes('`lib/`') && s.includes('暫存檔一律放你的工作夾(不寫專案之 `tmp/`)'), '做夢任務書之禁止段')
        assert(/不得匯入迴圈與評估器之程式\(`(?:node_modules\/w-trade-adaptivess\/)?src\/`\)/.test(s), '診斷腳本一條所指之程式夾')
        //規則 R-REC-26:「每輪至少 1 條向外」之例外 —— 可選之臂皆已試過、且本輪已預先核對 3 種以上而皆無內容; 種數與迴圈之門檻(OUT_CHECK_MIN)一致
        assert(s.includes('**例外(向外可為 0 條)**') && s.includes(`**${OUT_CHECK_MIN} 種以上**`) && s.includes('`synthesis.overview.outwardChecked`') && s.includes('尚有未試之臂、或只核了 1 ~ 2 種者,照舊須有向外'), '配比之例外條款')
        assert.equal(texts.dreamTemplate(ctx(toolbox)).synthesis.overview.outwardChecked, null, '交付範本含此欄(預設 null = 不適用)')
        //輪末摘要之附註(純函數): 有向外或無方向 ⇒ 無附註; 尚有未試之臂 ⇒ 標示; 皆已試過且已核達門檻 ⇒ 另列、不標示; 未達門檻 ⇒ 標示
        assert.equal(outwardNoteOf({ nOut: 1, nDirs: 2, nUntried: 0, nChecked: 0 }), '')
        assert.equal(outwardNoteOf({ nOut: 0, nDirs: 0, nUntried: 0, nChecked: 0 }), '')
        assert.equal(outwardNoteOf({ nOut: 0, nDirs: 3, nUntried: 2, nChecked: 9 }), ';**無向外之方向**(未試之可選臂尚有 2 個)', '尚有未試之臂時例外不適用')
        assert.equal(outwardNoteOf({ nOut: 0, nDirs: 1, nUntried: 0, nChecked: OUT_CHECK_MIN }), `;向外 0(預先核對皆不成立;${OUT_CHECK_MIN} 種)`)
        assert(/^;\*\*無向外之方向\*\*.*未達/.test(outwardNoteOf({ nOut: 0, nDirs: 1, nUntried: 0, nChecked: OUT_CHECK_MIN - 1 })), '只核 1 ~ 2 種者照舊標示')
        assert(s.includes('## 4. 擴建:共用工具(由你統籌並親手完成)'))
        assert(s.includes('**交付前執行 `node g_toolbox.mjs` 自檢**'), '自檢入口(與迴圈之機械檢查同一套規則;做夢不必自寫檢查腳本)')
        //規則 R-EV-36: 擴充診斷之資料存取(api.market / factor / series)列於做夢任務書之擴建一節(細節見合約 §7), 並註明「為某次決策分組只用該決策自己之決策棒或更早者」; 未啟用共用工具區者不出現
        assert(s.includes('`market` / `factor` / `series` 取某棒以前之行情、因子、外部序列之值'), '擴充診斷之資料存取之說明')
        assert(s.includes('為某次決策分組時 `bar` 只用該決策自己之決策棒或更早者'), '資料存取之分組須用該決策之決策棒或更早者(前視)')
        assert(!texts.dreamBrief(ctx(null)).includes('`market` / `factor` / `series`'))
        //規則 R-EV-38: replaceNull 可只換一部分之席(onlyGroups / onlyDecisions)亦列於同一節(細節見合約 §7); 未啟用共用工具區者不出現
        assert(s.includes('`replaceNull` 配對隨機替換(可只換所列子帳之席 `onlyGroups`、或只換遮罩內之決策之席 `onlyDecisions`)'), 'replaceNull 只換一部分之席之說明')
        assert(!texts.dreamBrief(ctx(null)).includes('`onlyGroups`'))
        //規則 R-EV-46: fillRandom(依各決策之兩側席數以活躍度匹配隨機填席)亦列於同一節(細節見合約 §7); 未啟用共用工具區者不出現
        assert(s.includes('`fillRandom` 依各決策之兩側席數以活躍度匹配隨機填席(回可直接交給 `simulate` 之選集'), 'fillRandom 之說明')
        assert(!texts.dreamBrief(ctx(null)).includes('`fillRandom`'))
        assert(s.includes('本輪節點自報:`n1aaaaaa` seat.mjs(依側配席)'))
        assert(s.includes('## 5. 參考') && s.includes('## 6. 交付') && s.includes('## 7. 禁止'))
        assert(s.includes('共用工具區 `rsi/toolbox/`、下述之專案指引文件'))
        let tpl = texts.dreamTemplate(ctx(toolbox))
        assert(Array.isArray(tpl.expansion) && 'type' in tpl.guidance.directions[0] && 'claim' in tpl.guidance.directions[0])
        let off = texts.dreamBrief(ctx(null))
        assert(!off.includes('擴建') && off.includes('## 4. 參考') && off.includes('## 6. 禁止'))
        assert.equal(texts.dreamTemplate(ctx(null)).expansion, undefined)
    })

    it('做夢範本之前次方向回顧(Gitea #154):帶鍵之探索方向(無主張)列依據之開頭;帶鍵之驗證列主張;不帶鍵者皆無;節點已自判者預填其判定', () => {
        //帶鍵之探索方向與既有節點同臂同起點 ⇒ 範本須能分辨兩條(不得兩條皆只有臂與輪次)
        let dir = (x, ck) => prevDirectionOf(3, { arms: ['A04_act'], base: null, ...x }, ck)
        //第三條: 探索類之方向殘留多餘之 claim 欄(例: 未刪範本之佔位文字)⇒ 依類型取依據, 不取 claim
        let pds = [dir({ type: 'explore', rationale: '  依據甲  ' }, 'a1b2c3d4'), dir({ type: 'verify', claim: '主張乙', rationale: 'r' }, '0a1b2c3d'), dir({ type: 'explore', claim: '殘留之佔位', rationale: '依據丁' }, 'e5f6a7b8'), dir({ rationale: '依據丙' }, null)]
        let node = { nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1', from: { round: 3, arms: ['A04_act'], base: null, claimKey: 'a1b2c3d4' }, claimVerdict: 'confirmed', claimNote: '節點之自判' }
        let c = { round: 4, nodeIds: ['n1aaaaaaaaaaaaaa'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r004'), context: { nodes: [node], failed: [], refs: [], prevDirections: pds, maxDirections: 7, extra: '2. 更新文件', toolbox } }
        let out = texts.dreamTemplate(c).synthesis.prevDirections
        assert.deepEqual(out.map((x) => [x.claim, x.rationale]), [[undefined, '依據甲'], ['主張乙', undefined], [undefined, '依據丁'], [undefined, undefined]])
        assert.deepEqual(pds.map((x) => x.claimKey), ['a1b2c3d4', '0a1b2c3d', 'e5f6a7b8', undefined])
        //節點之來源方向帶同一鍵者預填自判之判定; 不帶鍵之同臂方向不吃到(鍵不同 ⇒ 不是同一條)
        assert.deepEqual(out.map((x) => x.verdict.startsWith('confirmed |') ? 'pending' : x.verdict), ['confirmed', 'pending', 'pending', 'pending'])
    })

    //可疑方向與資訊來源之三級(規則 R-REC-47)。對應之原則:挑選應由各臂之機制找出,不得建構在策略庫之上層特徵(全庫之分佈、比例、整側或整群之彙總量)上;
    //  做夢任務書 §3 之「可疑方向」一段(資訊來源三級、六種形狀之處置)、審計規程第 8 點末之一句、`synthesis.summary` 之量尺句;節點任務書 §6 之第 7 條;合約 §5 之判讀名詞
    describe('可疑方向與資訊來源之三級(R-REC-47)', function () {
        let N1 = { nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
        let dctx = (extra = {}, nodes = [N1]) => ({ round: 9, nodeIds: nodes.map((n) => n.nodeId), reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r009'), context: { nodes, failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox, ...extra } })
        let dirV = { round: 6, doc: 'rsi/records/dreams/r006.md', rationale: '依據乙', expect: '預期丙', type: 'verify', claim: '主張甲' }
        let HEADS = ['**資訊來源分三級**', '**1. 側別曝險冒充挑選**', '**2. 以庫彙總量定側別或席次**', '**3. 以落後之延續規則定側別**', '**4. 同一個底之連續疊加**', '**5. 成員依賴**', '**6. 內容只在庫之某一類成員成立**']
        //「可疑方向」一段之各列(標題列 + 子條); 先斷言其位置(§3 之內、guidance.directions 之前)與單獨成段
        let paraOf = (d, name = '') => {
            let i3 = d.indexOf('\n## 3. 彙整與方向\n')
            let iH = d.indexOf('\n- **可疑方向**(')
            let iDir = d.indexOf('\n- `guidance.directions`:')
            let iEnd = d.indexOf('\n## ', i3 + 1)
            assert(i3 >= 0 && i3 < iH && iH < iDir && iDir < iEnd, `${name}位置:須在 §3 之內、guidance.directions 之前`)
            assert.equal(d.split('**可疑方向**').length - 1, 1, `${name}標題字樣只出現一次`)
            return d.slice(iH + 1, iDir + 1).split('\n').filter((l) => l !== '')
        }

        it('做夢任務書:「可疑方向」於 §3 單獨成段(標題列 + 7 個子條)、位於 guidance.directions 之前;三級與六種形狀之標題依序皆在;有 / 無共用工具區與只做夢輪次皆有', () => {
            //任務書之句:「須單獨成段、可被測試以標題字樣定位」「六種可疑形狀與處置」
            for (let [name, c] of [['一個節點', dctx()], ['無共用工具區', dctx({ toolbox: null })], ['只做夢輪次', dctx({ request: { why: '重審', dreamOnly: true } }, [])]]) {
                let ls = paraOf(texts.dreamBrief(c), `${name}:`)
                assert(ls[0].startsWith('- **可疑方向**('), name)
                assert.equal(ls.length, 1 + HEADS.length, `${name}:標題列 + ${HEADS.length} 個子條`)
                HEADS.forEach((h, k) => assert(ls[k + 1].startsWith(`  - ${h}`), `${name}:第 ${k + 1} 個子條應為 ${h}`))
            }
            //§3 之各條目其餘照舊在(新段不取代任一條): synthesis / plain / overview / directions / avoid / prevDirections / improvements / armProposals
            let d = texts.dreamBrief(dctx())
            for (let k of ['- `synthesis`:本輪學到什麼', '- `synthesis.plain`:', '- `synthesis.overview`:', '- `guidance.directions`:', '- `guidance.avoid`:', '- `synthesis.prevDirections`:', '- `guidance.improvements`:', '- `guidance.armProposals`:']) {
                assert.equal(d.split(`\n${k}`).length - 1, 1, k)
            }
            assert(d.indexOf('\n- `synthesis.overview`:') < d.indexOf('\n- **可疑方向**(') && d.indexOf('\n- **可疑方向**(') < d.indexOf('\n- `guidance.directions`:'), '次序:整體研判 → 可疑方向 → 方向之條目')
        })

        it('做夢任務書「可疑方向」之內容:三級之定義與第 3 級之要求(隨機半庫至少 6 個與分層子庫重算仍在才可稱挑選內容,未做者只列為候選);六種形狀各自之處置', () => {
            let ls = paraOf(texts.dreamBrief(dctx()))
            let has = (k, ...xs) => xs.forEach((x) => assert(ls[k].includes(x), `第 ${k} 列缺「${x}」:${ls[k].slice(0, 60)}`))
            //資訊來源三級(任務書:①策略自身之量 ②庫內相對 ③庫彙總量;第 3 級 = 把策略庫當行情之感測器)
            has(1, '**第 1 級 = 策略自身之量**(其進出場、已實現損益、進場條件、持倉狀態)', '**第 2 級 = 庫內相對**(同一次決策內之分位、名次、前若干比例)', '**第 3 級 = 庫彙總量**(整側、型態、因子家族、行為群之彙總損益或計數,全庫之做多比例,以全庫之中位或分位切型態)', '把策略庫當行情之感測器', '最依賴庫之組成')
            //標題列: 命中者依各項處置, 處置優先於該成品之分數(任務書之句:「處置優先於分數」)
            has(0, '命中者依下列各項處置,處置優先於該成品之分數;')
            has(1, '**用到第 3 級之成品,其內容須於隨機半庫(至少 6 個;', '`g_eval.mjs --member <鹽>:<0|1>`', '與分層子庫(', '重算後仍在,才可稱挑選內容**', '未做者只列為候選')
            //分層子庫之評估指向 --subset(規則 R-EV-47; 隨機半庫照舊可用 --member 或 --subset rand:…); 改前之「以模組內排除該類成員之版本另評估」不殘留
            has(1, '(拿掉或只留庫內某一類成員;分層者以 `g_eval.mjs --subset <規則>` 評估;隨機半庫照舊可用 `--member`,或 `--subset rand:…`)')
            assert(!ls[1].includes('模組內排除該類成員之版本') && !ls[1].includes('只切隨機半庫'), '改前之句不殘留')
            //1 側別曝險冒充挑選: 不列為已驗證之最高、不作為其後方向與預先核對之起點; 要在其上延伸者先以兩側席次固定之版本重做
            has(2, '「下單流量偏一側」', '`fixedState`', '`placeboTiming`', '(`placeboTiming`)無內容 ⇒ 記為側別曝險', '記為側別曝險', '不列 `worked`', '**不列為已驗證之最高、不作為其後方向與預先核對之起點**', '先以兩側席次固定之版本重做')
            //2 以庫彙總量定側別或席次: 同第 3 級之要求
            has(3, '依整側之彙總損益或全庫之做多比例配兩側之席次', '屬第 3 級,同上之要求', '隨機半庫與分層子庫重算仍在才可稱挑選內容,否則只是候選')
            //3 以落後之延續規則定側別: 須有兩種以上行情段之證據; 只在單一行情段成立者列 patterns
            has(4, '依近期已實現損益之好壞決定側別或席次', '須有兩種以上行情段(走勢方向不同之期間)之證據', '只在單一行情段成立者列 `patterns`', '不列 `worked`')
            //4 同一個底之連續疊加: 探索類之方向與預先核對至少一半改用側別中性之底
            has(5, '近數輪之方向與預先核對皆以同一成品或同一側別層為底', '**探索類之方向與預先核對至少一半改用側別中性之底**', '兩側席次固定之版本', '做不到須在 `adjust` 寫理由')
            //5 成員依賴: 內容保持率之中位 < 0.5 或任一半庫之相位平均為負 ⇒ 不列 worked; 「顯著」不等於穩健, 看量級之保持率
            has(6, '隨機半庫之內容保持率之中位 < 0.5', '任一半庫之相位平均為負', '不列 `worked`', '**「顯著」不等於穩健**', '各半庫內之 p 皆小只說明各半內有超額,不說明超額之量級仍在', '判定看內容保持率之量級')
            //6 內容只在庫之某一類成員成立: 標示其範圍, 不外推
            has(7, '某止盈止損帶、某持倉長度、某求解批次、某因子家族', '標示其範圍,不外推為一般之挑選內容')
            //名詞指向合約 §5
            assert(ls[0].includes('名詞定義見 `docs/pick-contract.md` §5「判讀名詞」'))
        })

        it('量尺句:並列「內容(組成對照之超額)最高且可信」與「回測期 S 最高且可信」之成品,並寫明是否同一個、後者是否命中第 1 項;原句不殘留。審計規程第 8 點末加一句(側別曝險不列 worked、不作為起點、以兩側席次固定之版本重做),原句之末仍為原文', () => {
            let d = texts.dreamBrief(dctx())
            let sum = d.split('\n').find((l) => l.startsWith('- `synthesis`:本輪學到什麼'))
            assert(sum.includes('每輪在 `summary` **並列**寫明**目前樹上「內容(組成對照之超額)最高且可信」之成品與「回測期 S 最高且可信」之成品各是哪一個、S 與最差相位各多少**(進度之量尺)'))
            assert(sum.includes('並寫明兩者是否為同一個、後者是否命中下述「可疑方向」第 1 項(命中者只是側別曝險,不是進度)。'))
            assert(!d.includes('目前樹上回測期 S 最高且可信之成品是哪一個'), '改前之量尺句不殘留')
            //審組成: 新句附於該列之末; 其前仍為原句之末(未被改動)
            let l8 = d.split('\n').find((l) => l.startsWith('8. **審組成**'))
            assert(l8.includes('只在其比例與成品相差 < 10% 時才可用來判時機**。 **迴圈檢查列「下單流量偏一側」、或擴充診斷之提示指出成品等同某一個固定狀態(例:`fixedState`)、同比例隨機時機之安慰劑(`placeboTiming`)無內容者,其優勢歸為側別曝險:彙整時不列 `worked`、不作為方向之起點;要保留其側內之機制者,於方向內指明以兩側席次固定之版本重做**(見 §3「可疑方向」)。'))
            assert(l8.endsWith('(見 §3「可疑方向」)。'), '新句為該列之末')
            //兩處之對應: 新句所指之第 1 項即「可疑方向」之第 1 項之處置(同為不列 worked、不作為起點、兩側席次固定之版本重做)
            assert.equal(d.split('兩側席次固定之版本重做').length - 1, 2, '「可疑方向」之第 1 項與審計規程之新句各一處')
        })

        it('節點任務書 §6 第 7 條:成品用到庫彙總量(第 3 級)者自報一句;探索類另交「兩側席次固定」之對照版、驗證類不另交;緊接第 6 條之後、在「## 7. 交付」之前;不新增必填之結構化欄位(範本不變);大小不逾 15,000 位元組', () => {
            let e = brief(task())
            let v = brief(task({ type: 'verify', claim: '主張甲', direction: dirV }))
            for (let [name, s] of [['探索', e], ['驗證', v]]) {
                let ls = s.split('\n')
                let i6 = ls.findIndex((l) => l.startsWith('6. 寫結論(`conclusion`)'))
                let i7 = ls.findIndex((l) => l.startsWith('7. **資訊來源**:'))
                assert(i6 >= 0 && i7 === i6 + 1, `${name}:第 7 條緊接第 6 條之後`)
                assert(ls[i7 + 1] === '' && ls[i7 + 2].startsWith('## 7. 交付'), `${name}:其後為交付一節`)
                assert.equal(s.split('7. **資訊來源**:').length - 1, 1, `${name}:只出現一次`)
                //任務書之句:「成品用到第③級之量(庫彙總量)者,於 conclusion.summary 自報一句「資訊來源:第 N 級(用到之彙總量是什麼)」」
                assert(ls[i7].includes('成品用到庫彙總量(第 3 級,見合約 §5)者,於 `conclusion.summary` 自報「資訊來源:第 3 級(用到之彙總量是什麼)」;'), name)
            }
            //探索類另交一個「兩側席次固定」之對照版(可即為 control.mjs, 或另存一檔並完整評估一次, 計入評估次數), 並寫出兩者之組成對照之超額
            let l7e = e.split('\n').find((l) => l.startsWith('7. **資訊來源**:'))
            assert(l7e.endsWith('探索類另交一個「兩側席次固定」之對照版(可即 `control.mjs`,或另存一檔並完整評估一次,計入評估次數),並寫出兩者之組成對照之超額。'))
            //驗證類之設計由方向定死: 只自報, 不另交對照版
            let l7v = v.split('\n').find((l) => l.startsWith('7. **資訊來源**:'))
            assert(l7v.endsWith(';驗證類不另交對照版。') && !v.includes('兩側席次固定'))
            //不新增必填之結構化欄位: 範本之鍵與改前相同(自報寫在 conclusion.summary)
            let keysOf = (t) => Object.keys(texts.nodeTemplate({ workDir: wd, task: t }).conclusion)
            assert.deepEqual(keysOf(task()), ['outcome', 'summary', 'findings', 'limitations', 'nextIdeas', 'armProposals'])
            assert.deepEqual(keysOf(task({ type: 'verify', claim: '主張甲', direction: dirV })), ['summary', 'findings', 'limitations', 'nextIdeas', 'armProposals', 'claimVerdict', 'claimNote'])
            assert.deepEqual(Object.keys(texts.nodeTemplate({ workDir: wd, task: task() })), ['plan', 'code', 'results', 'conclusion'])
            //大小: 本條務求精簡(節點任務書逾 15,000 位元組即整併); 無起點之探索與驗證、有無共同儲存區與其他標的之正負號之最大者皆不逾
            for (let t of [task(), task({ type: 'verify', claim: '主張甲', direction: dirV })]) {
                assert(Buffer.byteLength(brief(t)) <= 15000, `節點任務書 ${Buffer.byteLength(brief(t))} 位元組`)
            }
        })

        it('節點任務書:去掉第 7 條後與改前逐字相同(釘死):七種情境之輸出之 sha256 前 16 字,與改前(1.0.40)之輸出逐字相等時所取之值相同;含共同儲存區與其他標的之正負號者之大小仍不逾 15,000 位元組', () => {
            //取值方式:改前之 texts.mjs 與現行之 texts.mjs 於同一組設定與同一組輸入下產出節點任務書,兩者於去掉第 7 條之後逐字相等(路徑字樣正規化後)才取改前輸出之雜湊記於此;
            //  新舊之差只能是第 7 條(一整列);任務書之一般文字有意改動時,須重取並於變更說明列出理由
            let codeRoot = path.relative(st.FD_ROOT, path.join(FD_ROOT, 'src')).replace(/\\/g, '/')
            //共同儲存區之相對路徑(任務書內寫有; 暫存夾名含行程號)正規化為 <STORE>
            let storeRel = null
            let sha = (s) => {
                let ls = s.split('\n')
                let idx = ls.map((x, i) => (x.startsWith('7. **資訊來源**:') ? i : -1)).filter((i) => i >= 0)
                assert.equal(idx.length, 1, '第 7 條恰出現一次')
                ls.splice(idx[0], 1)
                let t = ls.join('\n').split(codeRoot).join('src')
                return crypto.createHash('sha256').update(storeRel ? t.split(storeRel).join('<STORE>') : t).digest('hex').slice(0, 16)
            }
            let armE = { id: 'E38_maxHoldN', layer: 'E', layerName: 'E 執行', title: '同時持倉上限', desc: 'accept 以 book.open 限制', grid: null }
            let baseNode = { nodeId: 'base000011112222', arms: ['A04_act', 'E39_skipWeekend'], inactiveArms: ['E39_skipWeekend'], S: 12.3, ladder: 1, backtest: null, doc: 'rsi/records/nodes/base000011112222.md' }
            let tv = () => task({ type: 'verify', claim: '主張甲', direction: dirV })
            let cases = [
                ['探索(無起點)', brief(task()), '8c0f293cb007f1d3'],
                ['探索(有起點;新加之臂屬執行層)', brief(task({ arms: [arm, armE], base: baseNode })), '836629dc02dd5ced'],
                ['探索(無共用工具區)', brief(task({ toolbox: null })), 'f493f2a552384c39'],
                ['驗證(來源方向)', brief(tv()), '4606ce4abdc3354e'],
                ['驗證(無共用工具區)', brief(task({ type: 'verify', claim: '主張甲', direction: dirV, toolbox: null })), '54712794b404ce39'],
            ]
            for (let [name, s, want] of cases) {
                assert.equal(sha(s), want, name)
            }
            //共同儲存區與其他標的之正負號(兩者皆有時任務書最長): 同樣只差第 7 條, 且不逾 15,000 位元組
            let root0 = path.join(FD_ROOT, 'test', '_tmp', `texts_suspect_${process.pid}`)
            fs.mkdirSync(path.join(root0, 'picks'), { recursive: true })
            try {
                fs.writeFileSync(path.join(root0, 'picks', 'INDEX.md'), '# 總表\n', 'utf8')
                fs.writeFileSync(path.join(root0, 'picks', '_cross.json'), '{}', 'utf8')
                let tx = makeTexts({ st: { ...st, rsi: { ...st.rsi, root: root0 } }, FD_ROOT: st.FD_ROOT })
                let nb = (t) => tx.nodeBrief({ workDir: wd, task: t, round: 7, nodeId: 'nodeX', attempt: 1 })
                let se = nb(task())
                let sv = nb(tv())
                storeRel = path.relative(st.FD_ROOT, path.join(root0, 'picks')).replace(/\\/g, '/')
                assert(se.includes(storeRel) && sv.includes(storeRel), '任務書內寫有共同儲存區之路徑(正規化之依據)')
                assert.equal(sha(se), '53462acc9007c693', '探索(有共同儲存區與其他標的之正負號)')
                assert.equal(sha(sv), '0ec4c7b045ac2e23', '驗證(有共同儲存區與其他標的之正負號)')
                for (let s of [se, sv]) {
                    assert(Buffer.byteLength(s) <= 15000, `節點任務書 ${Buffer.byteLength(s)} 位元組`)
                }
            }
            finally {
                fs.rmSync(root0, { recursive: true, force: true })
            }
        })

        it('合約 §5 之判讀名詞:資訊來源之三級、側別中性(兩側席次固定)、組成位移、內容保持率各一至兩句;經 renderContract 改寫(每根 24 小時)後仍在;任務書與合約同名同門檻', () => {
            let ref = fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8')
            let sec5 = ref.slice(ref.indexOf('\n## 5. 評估指令\n'), ref.indexOf('\n## 6. 常見錯誤\n'))
            assert(sec5.length > 100, '找得到 §5')
            let TERMS = ['**資訊來源之三級**', '**側別中性(兩側席次固定)**', '**組成位移**', '**內容保持率**']
            let blockOf = (text) => {
                let ls = text.split('\n')
                let i = ls.findIndex((l) => l.startsWith('- **判讀名詞**('))
                assert(i >= 0, '有「判讀名詞」一項')
                let out = []
                for (let l of ls.slice(i + 1)) {
                    if (!l.startsWith('  - ')) {
                        break
                    }
                    out.push(l)
                }
                return out
            }
            for (let [name, text] of [['參考版', sec5], ['每根 24 小時', renderContract(ref, { barHours: 24 })]]) {
                let ls = blockOf(text)
                assert.equal(ls.length, TERMS.length, `${name}:四個名詞`)
                TERMS.forEach((t, k) => {
                    assert(ls[k].startsWith(`  - ${t}:`), `${name}:第 ${k + 1} 個應為 ${t}`)
                    let n = (ls[k].match(/。/g) || []).length
                    assert(n >= 1 && n <= 2, `${name}:${t} 為一至兩句(${n})`)
                })
            }
            //任務書所指之名詞(節號與名稱)與合約同名; 第 5 項之門檻與隨機半庫之個數兩處一致
            let d = texts.dreamBrief(dctx())
            assert(d.includes('`docs/pick-contract.md` §5「判讀名詞」') && ref.includes('- **判讀名詞**('))
            //(合約之字樣只在「判讀名詞」一項內比對: 他處另有同樣之字串者不算)
            let defs = blockOf(sec5).join('\n')
            for (let k of ['隨機半庫', '分層子庫', '內容保持率', '兩側席次固定', '至少 6 個', '中位 < 0.5', '相位平均為負']) {
                assert(d.includes(k) && defs.includes(k), `任務書與合約之判讀名詞皆含「${k}」`)
            }
            //合約之判讀名詞為節點任務書所指之唯一定義處(節點任務書不重述): 各名詞之語意字句(第 3 級須經組成位移重算才可稱挑選內容; 內容 = 組成對照之超額;
            //  側別中性不同於同比例隨機時機之安慰劑; 組成位移 = 換一批成員重算同一個模組)
            for (let k of ['須經下列之組成位移重算仍在,才可稱挑選內容', '內容 = 組成對照之超額;同一個模組、同一種對照', '它與「同比例、隨機時機之安慰劑」不同 —— 後者保留成品之狀態比例、只打亂時機。', '換一批成員重算同一個模組']) {
                assert(defs.includes(k), `合約之判讀名詞含「${k}」`)
            }
            //組成位移之分層子庫以 --subset 評估(規則 R-EV-47); 改前之「以模組內排除該類成員之版本另評估」不殘留(任務書與合約兩處皆然)
            let SUBSET_SENT = '分層者以 `g_eval.mjs --subset <規則>` 評估;隨機半庫照舊可用 `--member`,或 `--subset rand:…`'
            assert(defs.includes(SUBSET_SENT) && d.includes(SUBSET_SENT), '合約與任務書皆指向 --subset')
            assert(!defs.includes('模組內排除該類成員之版本') && !d.includes('模組內排除該類成員之版本'), '改前之句不殘留')
            //合約之改寫錨點: 新增之字句不含 renderContract 之錨點字樣(含之者另一個專案之合約會殘留參考值; 殘留掃描見 unit-factsResidue)
            assert(!/七相位|七個相位|p ≤ 0\.05|分為 10 層|名次 ±50/.test(sec5.slice(sec5.indexOf('- **判讀名詞**('), sec5.indexOf('- **selHash**'))), '判讀名詞一項不含改寫之錨點字樣')
        })
    })
})
