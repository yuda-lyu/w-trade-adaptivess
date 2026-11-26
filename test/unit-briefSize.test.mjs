import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { briefMatrix, BRIEF_LIMIT, TYPES, BASES, STORES } from './tools/briefMatrix.mjs'
import { FD_ROOT } from './tools/synthLedger.mjs'


//節點任務書之大小(規則 R-REC-52; 排程第 588 項 ①): 15,000 位元組 = 「逾即整併」之維護門檻(texts.mjs 之註解、tools/briefPreview.mjs; 非執行期硬上限)
//  守門之範圍 = test/tools/briefMatrix.mjs 之情境表(探索 / 驗證 × 起點四種 × 有無共用工具區 × 儲存區三種 = 48 個; 不含來源方向之全文與重做之要求)
//  改前(1.0.45 之上): 其中 12 個逾門檻(有起點之探索、新加之臂屬執行層、無共同儲存區者本不逾而於 #203 之第 7 條後新逾: 14,847 → 15,188);整併後最大者餘裕 100 位元組以上
describe('節點任務書之大小(R-REC-52):情境表之全部組合不逾 15,000 位元組;整併後必要之規則與資訊仍在', function () {
    this.timeout(60000)
    let st = getSettings()
    let rows
    let TB = { ARM: '`rsi/toolbox/README.md`:**共用工具索引**' }
    let at = (type, base, toolbox, store) => {
        let r = rows.filter((x) => x.type === type && x.base === base && x.toolbox === toolbox && x.store === store)
        assert.equal(r.length, 1, `情境 ${type}/${base}/${toolbox}/${store} 恰一個`)
        return r[0]
    }
    before(() => {
        rows = briefMatrix({ makeTexts, st })
    })

    it('情境表之鑑別前提:軸之全部組合各一個(2 × 4 × 2 × 3 = 48);各軸之差異確實反映在任務書之文字上(無起點 / 起點之新臂屬執行層 / 起點有未作用之臂 / 共同儲存區 / 其他標的之正負號 / 共用工具區);最長者為「各項皆有」之探索', () => {
        assert.equal(rows.length, TYPES.length * BASES.length * 2 * STORES.length)
        assert.equal(new Set(rows.map((r) => `${r.type}/${r.base}/${r.toolbox}/${r.store}`)).size, rows.length, '各情境互異')
        for (let r of rows) {
            assert.equal(r.text.includes(r.type === 'explore' ? '- 無起點:從零寫。' : '以來源方向所指之成品為底'), r.base === 'none', `${r.type}/${r.base}: 無起點之句`)
            assert.equal(r.text.includes('起點節點 `base000011112222`'), r.base !== 'none', `${r.type}/${r.base}: 有起點之句`)
            assert.equal(r.text.includes('**新加之臂屬取法 / 執行層('), r.type === 'explore' && (r.base === 'exec' || r.base === 'execInactive'), `${r.type}/${r.base}: 新加之臂屬執行層之判讀句只在探索類且新臂屬 D / E 層者`)
            assert.equal(r.text.includes('起點所指派之臂中 E39_skipWeekend 於其交付版未作用'), r.base === 'execInactive', `${r.type}/${r.base}: 起點有未作用之臂之句`)
            assert.equal(r.text.includes(TB.ARM), r.toolbox, `${r.type}/${r.base}: 共用工具區`)
            assert.equal(r.text.includes('**動手前先看共同儲存區之總表**'), r.store !== 'none', `${r.store}: 共同儲存區之總表`)
            assert.equal(r.text.includes('**其他標的之正負號**'), r.store === 'cross', `${r.store}: 其他標的之正負號`)
            assert(!/BTC|他幣/.test(r.text))
        }
        let top = rows.slice().sort((a, b) => b.bytes - a.bytes)[0]
        assert.deepEqual([top.type, top.base, top.toolbox, top.store], ['explore', 'execInactive', true, 'cross'], '最長者 = 探索 × 起點(新臂屬執行層且有未作用之臂)× 有共用工具區 × 儲存區與其他標的之正負號(各項皆有)')
        assert(top.bytes > 13000, `最長者之位元組數 ${top.bytes}(過小者表示情境表未涵蓋實際之長度)`)
    })

    it('情境表之每個組合皆不逾 15,000 位元組(各情境之位元組數 = briefMatrix 之 bytes;逾者列出)', () => {
        let over = rows.filter((r) => r.bytes > BRIEF_LIMIT).sort((a, b) => b.bytes - a.bytes)
        assert.equal(over.length, 0, `逾 ${BRIEF_LIMIT} 位元組之情境 ${over.length} 個: ${over.slice(0, 12).map((r) => `${r.type}/${r.base}/${r.toolbox ? '工具區' : '無工具區'}/${r.store}=${r.bytes}`).join('、')}`)
    })

    it('排程第 588 項之點名情境:有起點、新加之臂屬執行層、無共同儲存區之探索(改前 14,847 → #203 後 15,188 新逾)不逾 15,000;有起點之驗證類、無起點者亦然', () => {
        for (let toolbox of [true, false]) {
            for (let base of ['exec', 'execInactive']) {
                assert(at('explore', base, toolbox, 'none').bytes <= BRIEF_LIMIT, `探索/${base}/${toolbox}/無儲存區`)
            }
        }
        assert(at('explore', 'execInactive', true, 'none').bytes < BRIEF_LIMIT - 500, '點名之情境(改前 15,188)離門檻有餘裕')
    })

    //整併不刪必要之規則與資訊: 整併前之任務書(1.0.45 之上)所載之規則與資訊,逐項仍在(移動者在新處; 逐處之「原句 → 新句」見規則帳本 R-REC-52)
    describe('整併後必要之規則與資訊仍在', function () {
        let each = (pred, anchors) => {
            for (let r of rows.filter(pred)) {
                for (let a of anchors) {
                    assert(r.text.includes(a), `${r.type}/${r.base}/${r.toolbox}/${r.store} 缺「${a}」`)
                }
            }
        }
        it('兩類共通:評估與診斷(`--period train` 只供診斷、不計入判讀)、與隨機挑比(同劑量虛無、組成對照、幾何對照、組成可重現之比例)、防偶然、`--ref` 與 `--member` 之用法、一實驗一檔', () => {
            each(() => true, [
                '`--period train` 可看同一模組在訓練期之表現,**只供診斷**(見 §5)', '不是績效之依據,**也不計入判讀**;`--period train` 只供診斷',
                '「同劑量虛無」(同決策時點、同選集大小、同執行規則之隨機挑)之超額與 p 說明挑法有沒有內容', '「同側同活躍度虛無」(組成對照)與「幾何對照」之超額與 p 為準**(定義見合約 §5,含損益歸因與三等分;完整評估一律算出,不必自己另跑替換版)', '「組成可重現之比例」接近 100% 者,績效來自方向與活躍度之組成,不是挑中了誰', '不同持倉上限或選集大小之 S 不能直接比,看超額與 p',
                '**防偶然**', '參數看平原(鄰近格點同向)不看單點最高', '同向比平均高更重要',
                '`--ref <模組>`:輸出本模組與參考模組', '**要報「名單換掉多少」「與某成品之重疊率」時用它**,不必自己在 `tag` 內算', '**重疊率以 `--mode quick` 量即可,不要為它多跑一次完整評估。**',
                '`--member <鹽>:<0|1>`:**成員重抽**', '模組不必改寫', '結果不是正本,交付之 `result_full.json` 不帶此選項', '每次評估照常記入評估紀錄(`--mode full` 者計入完整評估次數;細節見合約 §5)', '「換一批策略是否仍成立」',
                '不要自己寫程式讀策略庫或帳本檔計算績效', '**同一內容不要完整評估兩次**', '相異選集數', '**評估過之檔不再改寫**', '一次只執行一個評估指令',
            ])
        })

        it('交付一節:`results.claimed` 各欄之來源、`code.inactiveArms`、`code.shareable`(有共用工具區者)、`conclusion.armProposals` 之全部欄位與四種 kind 與「提案不影響本節點之任務」', () => {
            each(() => true, [
                '`results.claimed` 各欄之來源:`S` ← `score.S`', '`selHash` ← `metrics.selHash`', '`code.inactiveArms`:指派之臂中,**交付版未作用者**之 id;沒有則空陣列', '試過而關閉是正常結果,如實填寫即可',
                '`conclusion.armProposals`(選配;沒有就留空陣列):**臂目錄不是封閉的**', '各列一筆 `{ kind, arm, layer, title, mechanism, boundary, evidence }`', '`kind` = `new`(新臂)/ `layer`(新的一層,即新的臂之種類)/ `revise`(修訂既有臂之定義或範圍)/ `retire`(停用或併入他臂)',
                '`arm` = 既有臂之 id(`revise` / `retire` 必填)', '`title` = 名稱(`new` / `layer` 必填)', '`mechanism` = 機制之中性描述', '`boundary` = 與既有臂之界線', '`evidence` = 依據', '提案由做夢彙整、主控審查;**提案不影響本節點之任務**',
            ])
            each((r) => r.toolbox, ['`code.shareable`:你本次所寫、**其他節點也可能用到**之輔助各列一筆 `{ file, what }`,沒有則空陣列'])
        })

        it('探索類:去臂對照(起點之逐位複本、新加之臂屬執行層之判讀)、選集組成與下單集中度、`outcome` 之擇一值在範本、迭代之要求、依狀態切換之機制', () => {
            each((r) => r.type === 'explore', ['**去臂對照**', '**選集組成**', '臂若只改變這兩者,差值就不是臂之內容', '另把「下單集中度」列寫進 `findings`', '相對比較對象之判定(`outcome`,擇一值見範本)', '**依狀態切換之機制**', '**交付版須是「平原上的一點」而非單點最高**(見 §5「防偶然」', '迴圈會記錄評估次數與相異選集數'])
            each((r) => r.type === 'explore' && r.base !== 'none', ['`control.mjs` = **起點成品之逐位複本**(於工作夾內把 `base_pick.mjs` 原樣複製為 `control.mjs`)'])
            //「機制要說得出…」一句: 探索類由第 6 節第 1 點之 plan.hypotheses 之第一條要求(不重述); 驗證類無此要求 ⇒ 保留於 §5「防偶然」
            each((r) => r.type === 'explore', ['`plan.hypotheses` 之第一條寫「此機制抓到什麼市場結構或數據特徵,為何可望使回測期之績效更佳、且換一段期間仍成立」'])
            for (let r of rows.filter((x) => x.type === 'explore')) {
                assert(!r.text.includes('機制要說得出它抓到什麼結構'), `${r.base}/${r.toolbox}/${r.store}: 探索類不重述`)
            }
            each((r) => r.type === 'explore' && (r.base === 'exec' || r.base === 'execInactive'), ['不同規則之間不直接比 S'])
            let template = makeTexts({ st: { ...st, rsi: { ...st.rsi, guides: false } }, FD_ROOT: st.FD_ROOT }).nodeTemplate({ workDir: path.join(st.records.workDir, 'nodeX'), task: { type: 'explore', toolbox: null } })
            assert.equal(template.conclusion.outcome, 'improved | neutral | worse | failed(擇一)', '「擇一值見範本」所指之範本含 outcome 之擇一值')
        })

        it('驗證類:迴圈記錄之次數與相異選集數(第 3 點重述)、方向所定之設計、`claimVerdict` / `claimNote`', () => {
            each((r) => r.type === 'verify', ['迴圈會記錄完整評估之次數與相異選集數', '**填 `claimVerdict`**', '`claimNote`', '**只做方向指明之版本與對照**', '機制要說得出它抓到什麼結構、為何換一段期間仍可望成立'])
        })

        it('交叉引用之目標存在:任務書所寫「見合約 §5」「見 §5」「見 §6 第 3 點」「見 §6 第 5 點」之處,其目標確在(合約之該節、任務書自己之該節與該點)', () => {
            let contract = fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8')
            let sec5 = contract.slice(contract.indexOf('\n## 5. 評估指令\n'), contract.indexOf('\n## 6. 常見錯誤\n'))
            assert(sec5.length > 100)
            for (let a of ['**同側同活躍度虛無**', '**同側同幾何同活躍度虛無**', '**成員重抽之重放**', '**選集組成**', '--ref <參考模組.mjs>']) {
                assert(sec5.includes(a), `合約 §5 含「${a}」`)
            }
            each(() => true, ['## 5. 判準', '## 6. 做法要求', '\n3. **一實驗一檔**:', '\n5. '])
            each((r) => r.type === 'explore', ['每個版本另存 `try_<版本名>.mjs`'])
            each(() => true, ['(檔名見 §6 第 3 點)', '(見 §6 第 5 點;不要手改)', '(定義見合約 §5,含損益歸因與三等分;', '細節見合約 §5', '(見 §5)'])
        })
    })
})
