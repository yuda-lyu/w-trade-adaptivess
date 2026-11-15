import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { outwardNoteOf, OUT_CHECK_MIN } from '../src/domain/domain.mjs'


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
        //保留期只在「共同儲存區」之說明內出現(保留期由主控檢定, 只把正負號給節點與做夢; 規則 R-BT-4); 其餘各處仍不提保留期與他幣
        let noStore = (x) => x.split('\n').filter((l) => !l.includes('共同儲存')).join('\n')
        assert(!/旗標|樣本外|above|mixed|保留期|BTC/.test(noStore(s)), '共同儲存區之說明以外, 任務書不得出現檢定旗標之等級用語, 亦不提保留期與他幣')
        assert(!/BTC|他幣/.test(s))
        let d = texts.dreamBrief({ round: 1, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r001'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 4, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
        assert(d.includes('**你與節點共同之目標:找出自適應挑選策略,使回測期(2025-10-06 ~ 2026-07-31)之等效年化報酬更佳'))
        assert(d.includes('| 回測期 S / 最差相位 / 對隨機之超額 / 階梯 |') && d.includes('| **-12.3** / -30.1 / 8.2 / 0 |'))
        assert(d.includes('**審偶然**') && d.includes('**以回測期之績效為準**'))
        assert(!/回測期旗標|樣本外|保留期|BTC/.test(noStore(d)))
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
        assert(s.includes('本輪節點自報:`n1aaaaaa` seat.mjs(依側配席)'))
        assert(s.includes('## 5. 參考') && s.includes('## 6. 交付') && s.includes('## 7. 禁止'))
        assert(s.includes('共用工具區 `rsi/toolbox/`、下述之專案指引文件'))
        let tpl = texts.dreamTemplate(ctx(toolbox))
        assert(Array.isArray(tpl.expansion) && 'type' in tpl.guidance.directions[0] && 'claim' in tpl.guidance.directions[0])
        let off = texts.dreamBrief(ctx(null))
        assert(!off.includes('擴建') && off.includes('## 4. 參考') && off.includes('## 6. 禁止'))
        assert.equal(texts.dreamTemplate(ctx(null)).expansion, undefined)
    })
})
