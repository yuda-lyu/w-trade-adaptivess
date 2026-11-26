import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { EVAL_HINT, PEAK_HEAD, TWIN_HEAD, isRefPick, isEvalHint, evalHintBody, fullRowsOf, peakHintOf, twinHintOf, twinIndexOf, evalHintsOfDocs } from '../src/domain/verifyEvalHints.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//迴圈檢查之兩條機械提示(規則 R-REC-43 單峰交付、R-REC-44 選集與他節點相同; 只提示、不否決)
//  規格(R-REC-43): ①所計之列 = 評估紀錄中成功、完整評估、評估期、不帶成員抽樣、有選集指紋、不是參考檔(control.mjs、base_pick.mjs、ref_*.mjs; 兩條提示之單一來源)之列; 只計至該節點之 agent 結束之時刻
//    ②交付版 = 選集指紋等於正本者; 以相異之指紋為單位(同一指紋有多列者取最後一列之 S)③四者皆成立才提示: 相異之指紋 ≥ 6; 交付版之 S > 0; 交付版之 S 不低於其餘每一個; 其餘之 S 之中位 < 交付版之 S × 0.5
//    ④紀錄缺、空、含無法解析之列、無正本之指紋 ⇒ 不提示、不拋錯
//  規格(R-REC-44): ①命中 = 本節點之正本之選集指紋等於他節點之某一所計之列(同一套篩選)之指紋 ②驗證類之節點與其方向所指名要重複之對象(起點、方向內指名之節點)之間不比(兩個方向皆然)
//    ③句式: 臂組合不同 ⇒ 列對方之節點與檔名、兩者之臂之差 ⇒ 多出之臂未作用(本節點之臂為對方之真子集者不列); 臂組合相同 ⇒ 同一成品, 不作互相獨立之佐證 ④同一對方節點只列一次(其正本亦為此選集者取其交付檔之列), 臂組合不同者在前, 列至 3 個, 其餘列個數與 id
//    ⑤他節點之紀錄缺、壞 ⇒ 略過
//  呈現: 節點文件之迴圈檢查(置於末尾)與樹之 raw.issues 同一份; 看板之節點一覽(「S」標「單峰交付」、「臂」標「選集與他節點相同」、表前各一段); 未觸發者逐字不變
//  產生之時點: 輪末鉤子之派做夢之前(本輪之節點)、做夢之處置之後(另含重做者)、reverify 之後、--mode validate 之重掃(全樹); tools/scanCheck.mjs 以同一判定唯讀對照
//  合成資料: 各列之檔名、選集指紋、S 逐列相異; 時刻逐列遞增
let seq = 0
let T0 = Date.parse('2026-03-02T00:00:00Z')
//at(): 各列之時刻(每次呼叫加 1 秒); at(k): 第 k 分鐘(agent 結束之時刻與其後之列用; 遠晚於各列)
let at = (k = null) => new Date(T0 + (k === null ? ++seq * 1000 : k * 60000)).toISOString()
//line, 評估紀錄之一列(g_eval.mjs 之格式: at、pick、mode、h、[member]、ok、S、selHash)
let line = (pick, sel, S, ex = {}) => JSON.stringify({ at: ex.at || at(), pick, mode: ex.mode || 'full', ...(ex.period ? { period: ex.period } : {}), h: `h${++seq}`, ...(ex.member ? { member: ex.member } : {}), ok: ex.ok !== false, ...(ex.ok === false ? { code: 'PICK_RUN' } : { S, selHash: sel }) })
//peakLines, 交付版(pick.mjs, 指紋 fp, S dS)與其餘各版(try_<i>.mjs, 指紋 <fp>-<i>)之列
let peakLines = (fp, dS, others) => [...others.map((S, i) => line(`try_${i}.mjs`, `${fp}-${i}`, S)), line('pick.mjs', fp, dS)]
let PEAK_TXT = (dS, n, med) => `提示(單峰交付): 交付版之 S ${dS} 為完整評估之 ${n} 個相異選集(選集指紋)中之最高者,其餘 ${n - 1} 個之 S 之中位 ${med}(遠低於交付版)⇒ 交付版之 S 可能只是多次試驗中之最大值;以鄰點(鄰近參數之版本)與多抽之重放(換亂數種子與同分次序)判其是否偶然(不否決,由審計判定)`

describe('迴圈檢查之兩條機械提示:單峰交付、選集與他節點相同(規則 R-REC-43、R-REC-44)', function () {
    this.timeout(120000)

    describe('純函數', function () {
        it('參考檔之定義(兩條提示共用之單一來源):control.mjs、base_pick.mjs、ref_*.mjs(不分大小寫);其餘檔名不是', () => {
            for (let s of ['control.mjs', 'base_pick.mjs', 'ref_3f2a9c1b.mjs', 'ref_x.mjs', 'Control.mjs', 'REF_ab.MJS']) {
                assert.equal(isRefPick(s), true, s)
            }
            for (let s of ['pick.mjs', 'try_control.mjs', 'control2.mjs', 'base_pick2.mjs', 'myref_a.mjs', 'ref.mjs', 'control.js', 'ref_a.mjs.bak', '', 'undefined']) {
                assert.equal(isRefPick(s), false, s)
            }
            assert.deepEqual(EVAL_HINT, { peakMinSel: 6, peakRatio: 0.5, twinMaxList: 3 })
            assert(Object.isFrozen(EVAL_HINT))
        })

        it('所計之列:成功、完整評估、評估期、不帶成員抽樣、有選集指紋、非參考檔;S 非數值者記 null;無法解析之列略過', () => {
            let ls = [
                line('try_keep1.mjs', 'f-keep1', 11.1),
                line('try_fail.mjs', 'f-fail', 12.2, { ok: false }),
                //失敗之列而帶指紋與 S(現行之評估器不寫此形; 只以 ok 判定)
                JSON.stringify({ at: at(), pick: 'try_failsel.mjs', mode: 'full', h: 'hx0', ok: false, S: 12.7, selHash: 'f-failsel' }),
                line('try_quick.mjs', 'f-quick', 13.3, { mode: 'quick' }),
                line('try_train.mjs', 'f-train', 14.4, { period: 'train' }),
                line('try_postfit.mjs', 'f-postfit', 15.5, { period: 'postfit' }),
                line('try_bt.mjs', 'f-bt', 16.6, { period: 'backtest' }),
                line('try_member.mjs', 'f-member', 17.7, { member: '0x1:0' }),
                JSON.stringify({ at: at(), pick: 'try_nosel.mjs', mode: 'full', h: 'hx1', ok: true, S: 18.8 }),
                JSON.stringify({ at: at(), pick: 'try_emptysel.mjs', mode: 'full', h: 'hx2', ok: true, S: 19.9, selHash: '' }),
                line('control.mjs', 'f-control', 20.1),
                line('ref_ab12cd34.mjs', 'f-ref', 21.2),
                line('base_pick.mjs', 'f-base', 22.3),
                JSON.stringify({ at: at(), pick: 'try_nullS.mjs', mode: 'full', h: 'hx3', ok: true, S: null, selHash: 'f-nullS' }),
                JSON.stringify({ at: at(), pick: 'try_strS.mjs', mode: 'full', h: 'hx4', ok: true, S: '23.4', selHash: 'f-strS' }),
                JSON.stringify({ at: at(), pick: 'try_memnull.mjs', mode: 'full', h: 'hx5', member: null, ok: true, S: 24.5, selHash: 'f-memnull' }),
                'not json',
                '{"broken":',
                '[1, 2]',
                '',
                line('try_keep2.mjs', 'f-keep2', -25.6),
            ]
            assert.deepStrictEqual(fullRowsOf([...ls, 7, null]), [
                { pick: 'try_keep1.mjs', selHash: 'f-keep1', S: 11.1 },
                { pick: 'try_bt.mjs', selHash: 'f-bt', S: 16.6 },
                { pick: 'try_nullS.mjs', selHash: 'f-nullS', S: null },
                { pick: 'try_strS.mjs', selHash: 'f-strS', S: null },
                { pick: 'try_memnull.mjs', selHash: 'f-memnull', S: 24.5 },
                { pick: 'try_keep2.mjs', selHash: 'f-keep2', S: -25.6 },
            ])
            assert.deepEqual(fullRowsOf(null), [])
            assert.deepEqual(fullRowsOf('x'), [])
        })

        it('單峰交付:命中之字面值(交付版之 S、相異之指紋數、其餘之中位、判法);相異之指紋 5 個不提示、6 個提示(邊界)', () => {
            let r6 = fullRowsOf(peakLines('p6', 41.3, [3.7, -12.4, 8.9, 15.2, 20.6]))
            assert.equal(peakHintOf(r6, 'p6'), PEAK_TXT(41.3, 6, 8.9))
            assert(peakHintOf(r6, 'p6').startsWith(PEAK_HEAD) && isEvalHint(peakHintOf(r6, 'p6')))
            let r5 = fullRowsOf(peakLines('p5', 41.3, [3.7, -12.4, 8.9, 15.2]))
            //鑑別前提: r5 = r6 少一個其餘之版本(其餘之中位 6.3 亦遠低於一半, 只差個數)
            assert.strictEqual(peakHintOf(r5, 'p5'), null, '相異 5 個')
        })

        it('單峰交付:交付版非最高、S 為 0 或負 ⇒ 不提示;與另一版同分(不低於其餘每一個)⇒ 提示', () => {
            assert.strictEqual(peakHintOf(fullRowsOf(peakLines('pa', 30.1, [30.2, 1.1, 2.3, 3.4, 4.6])), 'pa'), null, '非最高')
            assert.strictEqual(peakHintOf(fullRowsOf(peakLines('pb', 0, [-30.2, -1.1, -2.3, -3.4, -4.6])), 'pb'), null, 'S 為 0')
            assert.strictEqual(peakHintOf(fullRowsOf(peakLines('pc', -0.4, [-30.2, -1.1, -2.3, -3.4, -4.6])), 'pc'), null, 'S 為負(其餘之中位更低)')
            assert.equal(peakHintOf(fullRowsOf(peakLines('pd', 30.1, [30.1, 1.1, 2.3, 3.4, 4.6])), 'pd'), PEAK_TXT(30.1, 6, 3.4), '同分')
            //鑑別前提: S 略大於 0 者照提示
            assert.equal(peakHintOf(fullRowsOf(peakLines('pe', 0.5, [-30.2, -1.1, -2.3, -3.4, -4.6])), 'pe'), PEAK_TXT(0.5, 6, -3.4))
        })

        it('單峰交付:其餘之中位恰為一半不提示、略低於一半提示(奇數與偶數個;偶數個取中間兩數之平均)', () => {
            assert.strictEqual(peakHintOf(fullRowsOf(peakLines('q1', 40, [1.2, 15.3, 20, 25.4, 35.5])), 'q1'), null, '奇數個之中位 = 20')
            assert.equal(peakHintOf(fullRowsOf(peakLines('q2', 40, [1.2, 15.3, 19.99, 25.4, 35.5])), 'q2'), PEAK_TXT(40, 6, 19.99))
            assert.strictEqual(peakHintOf(fullRowsOf(peakLines('q3', 40, [1.2, 15.3, 19, 21, 25.4, 35.5])), 'q3'), null, '偶數個之中位 = (19 + 21) / 2 = 20')
            assert.equal(peakHintOf(fullRowsOf(peakLines('q4', 40, [1.2, 15.3, 19, 20.98, 25.4, 35.5])), 'q4'), PEAK_TXT(40, 7, 19.99))
            //鑑別前提: 第三案之其餘(已排序)之中間兩數 19、21:偏低之一數 < 20 = 平均 ⇒ 中位之定義取錯者第三案會轉為提示
            let o3 = [1.2, 15.3, 19, 21, 25.4, 35.5]
            assert(o3[2] < 40 * 0.5 && (o3[2] + o3[3]) / 2 === 40 * 0.5)
        })

        it('單峰交付:同一指紋有多列 ⇒ 以相異之指紋計數、取最後一列之 S', () => {
            //交付版兩列(30 → 44)、另一版兩列(21 → 12); 依最後一列: 交付 44、其餘 2 / 3 / 12 / 16 / 17 之中位 12 < 22 ⇒ 提示
            let ls = [line('pick.mjs', 'm-d', 30), line('try_a.mjs', 'm-a', 21), line('try_b.mjs', 'm-b', 16), line('try_c.mjs', 'm-c', 17), line('try_e.mjs', 'm-e', 2), line('try_f.mjs', 'm-f', 3), line('try_a2.mjs', 'm-a', 12), line('pick.mjs', 'm-d', 44)]
            assert.equal(peakHintOf(fullRowsOf(ls), 'm-d'), PEAK_TXT(44, 6, 12))
            //鑑別前提: 只留各指紋之第一列(交付 30、其餘之中位 16 ≥ 15)則不提示
            let firstOnly = fullRowsOf(ls).filter((r, i, a) => a.findIndex((y) => y.selHash === r.selHash) === i)
            assert.equal(firstOnly.length, 6)
            assert.strictEqual(peakHintOf(firstOnly, 'm-d'), null)
            //列數 7、相異之指紋 5 ⇒ 不提示(以列數計者會提示)
            let ls5 = [line('pick.mjs', 'n-d', 44), line('try_a.mjs', 'n-a', 2), line('try_a2.mjs', 'n-a', 2), line('try_b.mjs', 'n-b', 3), line('try_b2.mjs', 'n-b', 3), line('try_c.mjs', 'n-c', 4), line('try_e.mjs', 'n-e', 5)]
            assert.equal(fullRowsOf(ls5).length, 7)
            assert.strictEqual(peakHintOf(fullRowsOf(ls5), 'n-d'), null)
        })

        it('單峰交付:只有參考檔與帶成員抽樣之列、正本之指紋不在所計之列、指紋非字串 ⇒ 不提示', () => {
            let ls = [line('pick.mjs', 'r-d', 41.3), line('control.mjs', 'r-1', 1.1), line('ref_aa11bb22.mjs', 'r-2', 2.2), line('base_pick.mjs', 'r-3', 3.3), line('try_m.mjs', 'r-4', 4.4, { member: '0x2:1' }), line('try_q.mjs', 'r-5', 5.5, { mode: 'quick' }), line('try_t.mjs', 'r-6', 6.6, { period: 'train' })]
            assert.strictEqual(peakHintOf(fullRowsOf(ls), 'r-d'), null)
            //鑑別前提: 同樣之 S 若為一般之版本即提示
            let ls2 = [line('pick.mjs', 's-d', 41.3), line('try_1.mjs', 's-1', 1.1), line('try_2.mjs', 's-2', 2.2), line('try_3.mjs', 's-3', 3.3), line('try_4.mjs', 's-4', 4.4), line('try_5.mjs', 's-5', 5.5)]
            assert.equal(peakHintOf(fullRowsOf(ls2), 's-d'), PEAK_TXT(41.3, 6, 3.3))
            assert.strictEqual(peakHintOf(fullRowsOf(ls2), 's-x'), null, '正本之指紋不在其中')
            for (let fp of [null, undefined, '', 7]) {
                assert.strictEqual(peakHintOf(fullRowsOf(ls2), fp), null, String(fp))
            }
            assert.strictEqual(peakHintOf(null, 's-d'), null)
        })

        //it_, 選集與他節點相同之輸入之一項
        let it_ = (id, arms, fingerprint, rows = [], type = 'explore', targets = []) => ({ id, arms, fingerprint, type, targets, rows })
        let rw = (pick, selHash) => ({ pick, selHash, S: 1 })
        it('選集與他節點相同:臂組合不同(本節點多出 / 互有出入)與相同之字面值;只對方多出者不列', () => {
            let A = it_('aa11bb22cc33dd44', ['A01_nt', 'D27_dedup', 'C21_holdStruct'], 'fpA', [rw('pick.mjs', 'fpA')])
            let B = it_('bb22cc33dd44ee55', ['A01_nt', 'D27_dedup'], 'fpB', [rw('pick.mjs', 'fpB'), rw('try_s7.mjs', 'fpA')])
            assert.equal(twinHintOf(A, twinIndexOf([A, B])), '提示(選集與他節點相同): 交付版之選集與 bb22cc33/try_s7.mjs 之完整評估逐位相同(選集指紋相同),臂組合不同(本節點多出 C21_holdStruct)⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂(不否決,由審計判定)')
            let C = it_('cc33dd44ee55ff66', ['A01_nt', 'D33_antiSticky'], 'fpC', [rw('try_k.mjs', 'fpA')])
            assert.equal(twinHintOf(A, twinIndexOf([A, C])), '提示(選集與他節點相同): 交付版之選集與 cc33dd44/try_k.mjs 之完整評估逐位相同(選集指紋相同),臂組合不同(本節點多出 D27_dedup、C21_holdStruct;對方多出 D33_antiSticky)⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂(不否決,由審計判定)')
            //本節點之臂為對方之真子集(只對方多出)⇒ 不列(本節點之成績未記到未作用之臂上; 例: 子節點關掉新臂之版本重現其起點)
            let D = it_('dd44ee55ff66aa77', ['A01_nt', 'D27_dedup', 'C21_holdStruct', 'A09_tpSl'], 'fpD', [rw('try_d.mjs', 'fpA')])
            assert.strictEqual(twinHintOf(A, twinIndexOf([A, D])), null)
            //鑑別前提: 同一列, 對方之臂改為互有出入即列
            //負向之寬鬆斷言(notEqual(x, null))要求非 null 且非 undefined ⇒ 嚴格版改寫為明示之等價式(排程第 622 項 ①)
            let hintD = twinHintOf(A, twinIndexOf([A, { ...D, arms: ['A01_nt', 'D27_dedup', 'A09_tpSl'] }]))
            assert.ok(hintD !== null && hintD !== undefined, '對方之臂互有出入 ⇒ 列提示')
            //臂組合相同(次序不同亦同)
            let E = it_('ee55ff66aa77bb88', ['C21_holdStruct', 'A01_nt', 'D27_dedup'], 'fpE', [rw('try_e.mjs', 'fpA')])
            assert.equal(twinHintOf(A, twinIndexOf([A, E])), '提示(選集與他節點相同): 交付版之選集與 ee55ff66/try_e.mjs 之完整評估逐位相同(選集指紋相同),臂組合亦相同 ⇒ 兩者為同一成品,不作互相獨立之佐證(不否決,由審計判定)')
            assert(isEvalHint(twinHintOf(A, twinIndexOf([A, E]))) && twinHintOf(A, twinIndexOf([A, E])).startsWith(TWIN_HEAD))
            //自身之列不命中; 無正本之指紋者不提示
            assert.strictEqual(twinHintOf(A, twinIndexOf([A])), null)
            assert.strictEqual(twinHintOf({ ...A, fingerprint: null }, twinIndexOf([A, B])), null)
        })

        it('選集與他節點相同:驗證類之節點與其方向所指名要重複之對象之間不比(兩個方向皆然);其他之驗證類照比', () => {
            let A = it_('aa11bb22cc33dd44', ['A01_nt'], 'fpA', [], 'verify', ['bb22cc33dd44ee55'])
            let B = it_('bb22cc33dd44ee55', ['A01_nt'], 'fpB', [rw('pick.mjs', 'fpA')])
            assert.strictEqual(twinHintOf(A, twinIndexOf([A, B])), null, '本節點為驗證類, 對方為其指名之對象')
            let V = it_('cc33dd44ee55ff66', ['A01_nt'], 'fpV', [rw('pick.mjs', 'fpB')], 'verify', ['bb22cc33dd44ee55'])
            assert.strictEqual(twinHintOf(B, twinIndexOf([B, V])), null, '對方為驗證類, 本節點為其指名之對象')
            let W = it_('dd44ee55ff66aa77', ['A01_nt'], 'fpW', [rw('pick.mjs', 'fpB')], 'verify', ['ff66aa77bb88cc99'])
            assert.equal(twinHintOf(B, twinIndexOf([B, W])), '提示(選集與他節點相同): 交付版之選集與 dd44ee55/pick.mjs 之完整評估逐位相同(選集指紋相同),臂組合亦相同 ⇒ 兩者為同一成品,不作互相獨立之佐證(不否決,由審計判定)', '他節點之驗證類而未指名本節點')
            //探索類之 targets 不作用(只有驗證類才排除)
            let X = it_('ee55ff66aa77bb88', ['A01_nt'], 'fpX', [rw('pick.mjs', 'fpB')], 'explore', ['bb22cc33dd44ee55'])
            let hintX = twinHintOf(B, twinIndexOf([B, X]))
            assert.ok(hintX !== null && hintX !== undefined, '探索類之 targets 不作用 ⇒ 列提示')
        })

        it('選集與他節點相同:兩方皆為驗證類而臂組合相同 ⇒ 不列(刻意之重複驗證);兩方皆驗證類而臂組合不同 ⇒ 列;一方驗證類、一方探索類而臂組合相同且未指名 ⇒ 列「同一成品」;同時命中應列與不列者 ⇒ 只列應列者', () => {
            //各驗證類之指名之對象皆為他節點(不含本例之任一方)
            let V1 = it_('aa11bb22cc33dd44', ['A01_nt', 'C21_holdStruct'], 'fpV1', [], 'verify', ['ff66aa77bb88cc99'])
            let V2 = it_('bb22cc33dd44ee55', ['C21_holdStruct', 'A01_nt'], 'fpV2', [rw('pick.mjs', 'fpV1')], 'verify', ['ff66aa77bb88cc99'])
            assert.strictEqual(twinHintOf(V1, twinIndexOf([V1, V2])), null, '兩方皆驗證類、同臂')
            //本節點為驗證類、對方為探索類(同臂、未指名)⇒ 列「同一成品」
            let X = { ...V2, id: 'cc33dd44ee55ff66', type: 'explore', targets: [] }
            assert.equal(twinHintOf(V1, twinIndexOf([V1, X])), '提示(選集與他節點相同): 交付版之選集與 cc33dd44/pick.mjs 之完整評估逐位相同(選集指紋相同),臂組合亦相同 ⇒ 兩者為同一成品,不作互相獨立之佐證(不否決,由審計判定)')
            //本節點為探索類、對方為驗證類(同臂、未指名本節點)⇒ 列
            let E = { ...V1, type: 'explore', targets: [] }
            assert.equal(twinHintOf(E, twinIndexOf([E, V2])), '提示(選集與他節點相同): 交付版之選集與 bb22cc33/pick.mjs 之完整評估逐位相同(選集指紋相同),臂組合亦相同 ⇒ 兩者為同一成品,不作互相獨立之佐證(不否決,由審計判定)')
            //兩方皆驗證類而臂組合不同 ⇒ 列(與類型無關)
            let V3 = it_('dd44ee55ff66aa77', ['A01_nt'], 'fpV3', [rw('try_v3.mjs', 'fpV1')], 'verify', ['ff66aa77bb88cc99'])
            assert.equal(twinHintOf(V1, twinIndexOf([V1, V3])), '提示(選集與他節點相同): 交付版之選集與 dd44ee55/try_v3.mjs 之完整評估逐位相同(選集指紋相同),臂組合不同(本節點多出 C21_holdStruct)⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂(不否決,由審計判定)')
            //同時命中 V2(不列)、V3(臂組合不同)、X(同一成品)⇒ 2 個節點, 臂組合不同者在前
            assert.equal(twinHintOf(V1, twinIndexOf([V1, V2, V3, X])), '提示(選集與他節點相同): 交付版之選集與 2 個節點之完整評估逐位相同(選集指紋相同)—— dd44ee55/try_v3.mjs:臂組合不同(本節點多出 C21_holdStruct)⇒ 多出之臂於評估期間未作用,審計時核對未作用之臂;cc33dd44/pick.mjs:臂組合相同 ⇒ 同一成品,不作互相獨立之佐證(不否決,由審計判定)')
            //只有不列者 ⇒ 無提示(不以「0 個節點」成句)
            assert.strictEqual(twinHintOf(V1, twinIndexOf([V1, V2, { ...V2, id: 'ee55ff66aa77bb88' }])), null)
        })

        it('選集與他節點相同:命中多個節點 ⇒ 臂組合不同者在前(其內依 id)、列至 3 個,其餘列個數與 id;同一對方只列一次(其正本亦為此選集者取交付檔之列,否則取最後一列;多個檔註明)', () => {
            let A = it_('aa11bb22cc33dd44', ['A01_nt', 'B16_perTradeQuality'], 'fpA')
            let o = [
                it_('f1f1f1f1aaaaaaaa', ['A01_nt', 'B16_perTradeQuality'], 'fpA', [rw('pick.mjs', 'fpA'), rw('try_late.mjs', 'fpA')]),
                it_('e2e2e2e2bbbbbbbb', ['A01_nt'], 'fpE2', [rw('try_x1.mjs', 'fpA'), rw('try_x2.mjs', 'fpA'), rw('try_x1.mjs', 'fpA')]),
                it_('c3c3c3c3cccccccc', ['B16_perTradeQuality', 'A01_nt'], 'fpC3', [rw('try_c.mjs', 'fpA'), rw('pick.mjs', 'fpA')]),
                it_('d4d4d4d4dddddddd', ['A01_nt', 'B16_perTradeQuality'], 'fpD4', [rw('try_d.mjs', 'fpA')]),
                it_('b5b5b5b5eeeeeeee', ['A01_nt', 'C19_jaccard'], 'fpB5', [rw('try_b.mjs', 'fpA')]),
            ]
            let s = twinHintOf(A, twinIndexOf([A, ...o]))
            assert.equal(s, '提示(選集與他節點相同): 交付版之選集與 5 個節點之完整評估逐位相同(選集指紋相同)—— b5b5b5b5/try_b.mjs:臂組合不同(本節點多出 B16_perTradeQuality;對方多出 C19_jaccard)⇒ 多出之臂於評估期間未作用,審計時核對未作用之臂;e2e2e2e2/try_x1.mjs(另 1 個檔亦同):臂組合不同(本節點多出 B16_perTradeQuality)⇒ 多出之臂於評估期間未作用,審計時核對未作用之臂;c3c3c3c3/pick.mjs(另 1 個檔亦同):臂組合相同 ⇒ 同一成品,不作互相獨立之佐證;另 2 個節點(d4d4d4d4、f1f1f1f1)(不否決,由審計判定)')
            //e2: 取最後一列(try_x1.mjs; 兩個相異之檔); c3: 其正本不是此選集 ⇒ 取最後一列(pick.mjs); f1: 其正本即此選集 ⇒ 取交付檔之列(pick.mjs, 非最後一列)
            let s2 = twinHintOf(A, twinIndexOf([A, o[0]]))
            assert(s2.includes('f1f1f1f1/pick.mjs(另 1 個檔亦同)'), s2)
            let s3 = twinHintOf(A, twinIndexOf([A, { ...o[0], fingerprint: 'fpOther' }]))
            assert(s3.includes('f1f1f1f1/try_late.mjs(另 1 個檔亦同)'), s3)
            //只列 id 前 8 碼, 至多 10 個之後以「…」
            let many = Array.from({ length: 14 }, (_, i) => it_(`${String(i).padStart(2, '0')}abcdef12345678`, ['A01_nt', 'B16_perTradeQuality'], `fpM${i}`, [rw(`try_m${i}.mjs`, 'fpA')]))
            let s4 = twinHintOf(A, twinIndexOf([A, ...many]))
            assert(s4.endsWith(';另 11 個節點(03abcdef、04abcdef、05abcdef、06abcdef、07abcdef、08abcdef、09abcdef、10abcdef、11abcdef、12abcdef …)(不否決,由審計判定)'), s4)
            assert.equal(evalHintBody(s4).endsWith('12abcdef …)'), true)
            assert.equal(evalHintBody('其他字串(不否決,由審計判定)'), '其他字串(不否決,由審計判定)', '非本兩條提示者原樣')
        })
    })

    describe('結構:判定在 verifyEvalHints.mjs(節點之禁區字樣涵蓋;規則 R-REC-43、R-REC-44、R-BT-10)', function () {
        it('判定與門檻之常數只在 src/domain/verifyEvalHints.mjs 定義一次;verify.mjs 不含、不匯出;領域與 scanCheck 自新模組匯入;聚合入口不加;匯出面固定', async () => {
            let read = (...p) => fs.readFileSync(path.join(FD_ROOT, ...p), 'utf8')
            let names = ['REF_PICK', 'isRefPick', 'EVAL_HINT', 'PEAK_HEAD', 'TWIN_HEAD', 'HINT_TAIL', 'isEvalHint', 'evalHintBody', 'fullRowsOf', 'medianOf', 'peakHintOf', 'twinIndexOf', 'pairExcluded', 'twinHintOf', 'evalHintsOfDocs']
            let src = read('src', 'domain', 'verifyEvalHints.mjs')
            let vsrc = read('src', 'domain', 'verify.mjs')
            for (let n of names) {
                assert.equal((src.match(new RegExp(`^let ${n} = `, 'gm')) || []).length, 1, `${n} 在新模組定義一次`)
                assert.equal((vsrc.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length, 0, `verify.mjs 不含 ${n}`)
            }
            let verify = await import('../src/domain/verify.mjs')
            for (let n of names) {
                assert(!(n in verify), `verify.mjs 不匯出 ${n}`)
            }
            assert.deepEqual(Object.keys(await import('../src/domain/verifyEvalHints.mjs')).sort(), ['EVAL_HINT', 'PEAK_HEAD', 'TWIN_HEAD', 'evalHintBody', 'evalHintsOfDocs', 'fullRowsOf', 'isEvalHint', 'isRefPick', 'peakHintOf', 'twinHintOf', 'twinIndexOf'])
            assert(/from '\.\/verifyEvalHints\.mjs'/.test(read('src', 'domain', 'domain.mjs')), '領域自新模組匯入')
            assert(/from '\.\.\/domain\/verifyEvalHints\.mjs'/.test(read('src', 'tools', 'scanCheck.mjs')), 'scanCheck 自新模組匯入')
            assert(!/verifyEvalHints|evalHintsOfDocs/.test(read('src', 'WTradeAdaptivess.mjs')), '聚合入口不加')
            //新模組自 verify.mjs 只取 evalLines(讀評估紀錄之既有函數)與 dirNodeIdsOf(方向內指名之節點之共用求法,不另寫一份); verify.mjs 不匯入新模組(無循環)
            assert(/^import \{ evalLines, dirNodeIdsOf \} from '\.\/verify\.mjs'$/m.test(src))
            assert(!/matchAll\(\/\\b\[0-9a-f\]\{8,16\}\\b\/g\)/.test(src), '指名之節點不另寫一份')
            assert(!/verifyEvalHints/.test(vsrc))
        })
    })

    describe('evalHintsOfDocs(讀各節點之工作夾)', function () {
        let t
        beforeEach(() => {
            t = makeTmp('evalHints')
        })
        afterEach(() => {
            t.cleanup()
        })
        //doc, 節點文件之最小形(evalHintsOfDocs 所讀之欄); log: 字串陣列(評估紀錄之各列)| 字串(原文)| null(無此檔); dir = 無工作夾
        let put = (root, { id, arms, fp, type = 'explore', base = null, dir = null, end = null, ok = true, log = [], noDir = false }) => {
            if (!noDir) {
                fs.mkdirSync(path.join(root, id), { recursive: true })
                if (log !== null) {
                    fs.writeFileSync(path.join(root, id, '.evals.log'), Array.isArray(log) ? `${log.join('\n')}\n` : log, 'utf8')
                }
            }
            return { nodeId: id, spec: { arms, base }, task: { type, direction: dir }, agent: end ? { endedAt: end } : null, harness: { ok, fingerprint: fp } }
        }
        it('雙向(同一輪之兩個節點各自得到提示)、單峰交付先列;他節點之紀錄缺 / 空 / 壞、無工作夾 ⇒ 略過不拋錯', () => {
            let w = t.dir
            let docs = [
                put(w, { id: 'a1a1a1a1a1a1a1a1', arms: ['A01_nt', 'D27_dedup'], fp: 'g-A', log: [...peakLines('g-A', 41.3, [3.7, -12.4, 8.9, 15.2, 20.6]), line('try_twin.mjs', 'g-B', 9.4)] }),
                put(w, { id: 'b2b2b2b2b2b2b2b2', arms: ['A01_nt', 'B16_perTradeQuality'], fp: 'g-B', log: [line('pick.mjs', 'g-B', 9.4), line('try_y.mjs', 'g-A', 41.3)] }),
                put(w, { id: 'c3c3c3c3c3c3c3c3', arms: ['C19_jaccard'], fp: 'g-C', log: null }),
                put(w, { id: 'd4d4d4d4d4d4d4d4', arms: ['C20_exitStruct'], fp: 'g-D', log: '' }),
                put(w, { id: 'e5e5e5e5e5e5e5e5', arms: ['C21_holdStruct'], fp: 'g-E', log: 'not json\n{"at":\n' }),
                put(w, { id: 'f6f6f6f6f6f6f6f6', arms: ['C22_calendar'], fp: 'g-F', noDir: true }),
            ]
            let m = evalHintsOfDocs(docs, w)
            assert.deepEqual([...m.keys()].sort(), ['a1a1a1a1a1a1a1a1', 'b2b2b2b2b2b2b2b2'])
            //a1: 相異 7 個(另含 g-B 之列), 其餘之中位 (8.9 + 9.4) / 2
            assert.deepEqual(m.get('a1a1a1a1a1a1a1a1'), [PEAK_TXT(41.3, 7, 9.15), '提示(選集與他節點相同): 交付版之選集與 b2b2b2b2/try_y.mjs 之完整評估逐位相同(選集指紋相同),臂組合不同(本節點多出 D27_dedup;對方多出 B16_perTradeQuality)⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂(不否決,由審計判定)'])
            assert.deepEqual(m.get('b2b2b2b2b2b2b2b2'), ['提示(選集與他節點相同): 交付版之選集與 a1a1a1a1/try_twin.mjs 之完整評估逐位相同(選集指紋相同),臂組合不同(本節點多出 B16_perTradeQuality;對方多出 D27_dedup)⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂(不否決,由審計判定)'])
            assert.deepEqual([...evalHintsOfDocs([], w).keys()], [])
            assert.deepEqual([...evalHintsOfDocs(null, w).keys()], [])
        })

        it('對方之列為參考檔 / 帶成員抽樣 / 快速評估 / 失敗 / 其他期間者不命中;未通過之節點(harness.ok 非 true)不得提示,其列照比', () => {
            let w = t.dir
            let docs = [
                put(w, { id: 'a1a1a1a1a1a1a1a1', arms: ['A01_nt'], fp: 'h-A', log: [line('pick.mjs', 'h-A', 5.1)] }),
                put(w, { id: 'b2b2b2b2b2b2b2b2', arms: ['A02_ntPit'], fp: 'h-B', log: [line('control.mjs', 'h-A', 5.1), line('ref_a1a1a1a1.mjs', 'h-A', 5.1), line('base_pick.mjs', 'h-A', 5.1), line('try_m.mjs', 'h-A', 5.1, { member: '0x3:0' }), line('try_q.mjs', 'h-A', 5.1, { mode: 'quick' }), line('try_f.mjs', 'h-A', 5.1, { ok: false }), line('try_p.mjs', 'h-A', 5.1, { period: 'postfit' })] }),
                put(w, { id: 'c3c3c3c3c3c3c3c3', arms: ['A04_act'], fp: 'h-C', ok: false, log: [line('pick.mjs', 'h-C', 6.2)] }),
                put(w, { id: 'd4d4d4d4d4d4d4d4', arms: ['A05_nKeys'], fp: 'h-D', log: [line('try_z.mjs', 'h-C', 6.2)] }),
            ]
            let m = evalHintsOfDocs(docs, w)
            assert.equal(m.has('a1a1a1a1a1a1a1a1'), false, '參考檔、成員抽樣、快速、失敗、其他期間之列皆不命中')
            assert.equal(m.has('c3c3c3c3c3c3c3c3'), false, '未通過之節點不得提示')
            //鑑別前提: 同一列改為一般之版本即命中
            let docs2 = [docs[0], put(w, { id: 'b2b2b2b2b2b2b2b2', arms: ['A02_ntPit'], fp: 'h-B', log: [line('try_plain.mjs', 'h-A', 5.1)] })]
            assert.equal(evalHintsOfDocs(docs2, w).has('a1a1a1a1a1a1a1a1'), true)
        })

        it('驗證類之指名:起點與方向內指名之節點(完整 id 或前 8 碼以上且唯一對應)不比;前綴對應不唯一者不算指名', () => {
            let w = t.dir
            let docs = [
                put(w, { id: 'a1a1a1a1a1a1a1a1', arms: ['A01_nt'], fp: 'v-A', log: [line('pick.mjs', 'v-A', 7.1)] }),
                put(w, { id: 'b2b2b2b2b2b2b2b2', arms: ['A01_nt'], fp: 'v-A', type: 'verify', base: 'a1a1a1a1a1a1a1a1', log: [line('pick.mjs', 'v-A', 7.1)] }),
                put(w, { id: 'c3c3c3c3c3c3c3c3', arms: ['A01_nt'], fp: 'v-C', log: [line('pick.mjs', 'v-C', 7.2)] }),
                put(w, { id: 'd4d4d4d4d4d4d4d4', arms: ['A01_nt'], fp: 'v-C', type: 'verify', dir: { claim: '主張', rationale: '重複 c3c3c3c3 之成品', expect: '' }, log: [line('pick.mjs', 'v-C', 7.2)] }),
                put(w, { id: 'e5e5e5e5aaaaaaaa', arms: ['A02_ntPit'], fp: 'v-E', log: [line('pick.mjs', 'v-E', 7.3)] }),
                put(w, { id: 'e5e5e5e5bbbbbbbb', arms: ['A04_act'], fp: 'v-E2', log: [] }),
                put(w, { id: 'f6f6f6f6f6f6f6f6', arms: ['A02_ntPit'], fp: 'v-E', type: 'verify', dir: { claim: '', rationale: '', expect: '對照 e5e5e5e5 之成品' }, log: [line('pick.mjs', 'v-E', 7.3)] }),
            ]
            let m = evalHintsOfDocs(docs, w)
            assert.equal(m.has('a1a1a1a1a1a1a1a1') || m.has('b2b2b2b2b2b2b2b2'), false, '起點')
            assert.equal(m.has('c3c3c3c3c3c3c3c3') || m.has('d4d4d4d4d4d4d4d4'), false, '方向內指名(前 8 碼)')
            assert.equal(m.has('e5e5e5e5aaaaaaaa') && m.has('f6f6f6f6f6f6f6f6'), true, '前 8 碼對應兩個節點 ⇒ 不算指名')
        })

        it('只計至各節點之 agent 結束之時刻(其後之列是做夢或主控之評估):本節點之單峰交付與他節點之命中皆然', () => {
            let w = t.dir
            let end = at(1000)
            let late = { at: at(2000) }
            let docs = [
                put(w, { id: 'a1a1a1a1a1a1a1a1', arms: ['A01_nt'], fp: 'u-A', end, log: [...peakLines('u-A', 41.3, [3.7, -12.4, 8.9, 15.2]), line('try_late.mjs', 'u-A-late', 2.6, late)] }),
                put(w, { id: 'b2b2b2b2b2b2b2b2', arms: ['A02_ntPit'], fp: 'u-B', end, log: [line('pick.mjs', 'u-B', 4.1), line('dream_copy.mjs', 'u-A', 41.3, late)] }),
            ]
            assert.deepEqual([...evalHintsOfDocs(docs, w).keys()], [], '結束之後之列不計')
            //鑑別前提: 未記結束之時刻者全部之列皆計 ⇒ 兩條皆命中
            let docs2 = docs.map((d) => ({ ...d, agent: null }))
            let m2 = evalHintsOfDocs(docs2, w)
            let h2 = m2.get('a1a1a1a1a1a1a1a1')
            assert(h2.length === 2 && h2[0].startsWith(PEAK_HEAD) && h2[1].startsWith(TWIN_HEAD) && h2[1].includes('b2b2b2b2/dream_copy.mjs'), JSON.stringify(h2))
        })
    })

    describe('領域之接線(真之樹與領域;各呼叫點)', function () {
        let t
        beforeEach(() => {
            t = makeTmp('evalHintsDomain')
        })
        afterEach(() => {
            t.cleanup()
        })
        //N: 節點之表(各欄逐節點相異); 1 = 單峰交付(第 1 輪)、2 與 3 = 臂組合不同之雙胞(第 2 輪; 3 之 try 檔 = 2 之交付版)、4 與 5 = 臂組合相同(5 之 try 檔 = 4 之交付版; 假做夢刪除 5)、6 = 未觸發
        let N = [
            { k: 1, arms: ['A01_nt'], round: 1, S: 41.3, fp: 'k1-d', log: () => peakLines('k1-d', 41.3, [3.7, -12.4, 8.9, 15.2, 20.6]) },
            { k: 2, arms: ['A02_ntPit', 'D27_dedup'], round: 2, S: 33.7, fp: 'k2-d', log: () => [line('pick.mjs', 'k2-d', 33.7), line('try_a.mjs', 'k2-a', 12.4)] },
            { k: 3, arms: ['A02_ntPit', 'B16_perTradeQuality'], round: 2, S: 31.9, fp: 'k3-d', log: () => [line('pick.mjs', 'k3-d', 31.9), line('try_q.mjs', 'k2-d', 33.7)] },
            { k: 4, arms: ['C19_jaccard'], round: 2, S: 14.6, fp: 'k4-d', log: () => [line('pick.mjs', 'k4-d', 14.6)] },
            { k: 5, arms: ['C19_jaccard'], base: 1, round: 2, S: -7.2, fp: 'k5-d', log: () => [line('pick.mjs', 'k5-d', -7.2), line('try_w.mjs', 'k4-d', 14.6)] },
            { k: 6, arms: ['A04_act'], round: 1, S: 8.8, fp: 'k6-d', log: () => [line('pick.mjs', 'k6-d', 8.8), line('control.mjs', 'k2-d', 33.7)] },
        ]
        let mk = ({ nodes = N, del = null } = {}) => {
            let st = getSettings()
            let d = path.join(t.dir, `proj_${++seq}`)
            st.resources = {}
            st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), autoFill: false, docLimits: false }
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthHints' }), 'utf8')
            let briefs = []
            let ids = {}
            let dispatch = async (role, { prompt }) => {
                if (role !== 'dream') {
                    throw new Error('fake: 不派節點')
                }
                let wd = path.resolve(st.FD_ROOT, /請閱讀 (\S+)\/brief\.md/.exec(prompt)[1])
                briefs.push(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
                let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
                let audits = tpl.audits.map((a) => (del && a.nodeId === ids[del] ? { nodeId: a.nodeId, trust: 'untrusted', action: 'delete', evidence: ['假審計'], issues: [], deleteWhy: '假做夢判刪除' } : { nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] }))
                fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits, synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }), 'utf8')
                return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
            }
            let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            //reopen, 同一專案(同一棵樹、同一批文件與工作夾)另組一個專案物件, 帶另給之注入(例: 會拋錯之判定)
            let reopen = (extra) => {
                let P2 = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json'), ...extra })
                P2.rsi.init()
                return P2
            }
            let specOf = (x) => ({ arms: x.arms.slice().sort(), base: x.base ? ids[x.base] : null })
            for (let x of nodes) {
                ids[x.k] = P.idOf(specOf(x))
            }
            for (let x of nodes) {
                let id = ids[x.k]
                let spec = specOf(x)
                let metrics = { selHash: x.fp, op: { eqYr: { mean: 10 + x.k * 1.3, min: -2 - x.k * 0.4, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + x.k) }, monthlyOrders: { mean: 80 + x.k }, peakHold: { max: 20 + x.k } }, null: { mean: -3 - x.k, excess: 5 + x.k, z: 1 + x.k / 10, p: 0.002 * x.k } }
                let issues = [`自報 S ${x.S + 0.5} 與重跑 ${x.S} 不符`]
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: x.round, raw: { metrics, issues: issues.slice(), selHash: x.fp }, score: { S: x.S, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: null } })
                P.records.putNodeDoc({ nodeId: id, round: x.round, attempt: 1, status: 'verified', createdAt: at(), spec, task: { goal: '合成', type: 'explore', claim: null, arms: [], base: null, refs: [], direction: null }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: at(), endedAt: at(5000 + x.k), durationSec: 600 + x.k, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S: x.S + 0.5 }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [] }, harness: { ok: true, summary: [], notes: [], score: { S: x.S, ladder: 1, flags: { vetoed: false, why: [] } }, fingerprint: x.fp, checks: { issues: issues.slice(), nEvals: 2 + x.k }, validation: null, raw: { metrics }, evalJson: null, error: null }, audit: null, history: [] })
                fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
                fs.writeFileSync(path.join(st.records.workDir, id, '.evals.log'), `${x.log().join('\n')}\n`, 'utf8')
            }
            let rd = (f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
            let docOf = (k) => P.records.getNodeDoc(ids[k])
            let mdOf = (k) => fs.readFileSync(P.records.paths.nodeMd(ids[k]), 'utf8')
            let jsonText = (k) => fs.readFileSync(P.records.paths.nodeJson(ids[k]), 'utf8')
            let treeIssues = (k) => P.rsi.store.getNode(ids[k]).raw.issues
            let hintsOf = (k) => ((docOf(k) && docOf(k).harness.checks.issues) || []).filter(isEvalHint)
            let logText = () => {
                try {
                    return fs.readFileSync(path.join(st.rsi.root, 'logs', 'arsi.log'), 'utf8')
                }
                catch (err) {
                    return ''
                }
            }
            return { P, st, d, ids, briefs, rd, docOf, mdOf, jsonText, treeIssues, hintsOf, reopen, logText }
        }
        let id8 = (x, k) => x.ids[k].slice(0, 8)

        it('輪末鉤子:派做夢之前重產本輪之節點(做夢之審計範圍表之迴圈檢查欄帶之);處置之後再重產(被刪除之對方之提示移除);較早之輪之節點不在輪末重寫', async () => {
            let x = mk({ del: 5 })
            let before1 = x.jsonText(1)
            let r2 = N.filter((n) => n.round === 2).map((n) => x.P.rsi.store.getNode(x.ids[n.k]))
            await x.P.domain.hooks.afterRound({ round: 2, nodes: r2 })
            //派做夢之前: 任務書之審計範圍表(迴圈檢查欄)含 2、3、4 之提示
            let rowOfBrief = (k) => x.briefs[0].split('\n').find((l) => l.startsWith(`| \`${x.ids[k]}\` |`)) || ''
            let tw2 = `提示(選集與他節點相同): 交付版之選集與 ${id8(x, 3)}/try_q.mjs 之完整評估逐位相同(選集指紋相同),臂組合不同(本節點多出 D27_dedup;對方多出 B16_perTradeQuality)⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂(不否決,由審計判定)`
            let tw4 = `提示(選集與他節點相同): 交付版之選集與 ${id8(x, 5)}/try_w.mjs 之完整評估逐位相同(選集指紋相同),臂組合亦相同 ⇒ 兩者為同一成品,不作互相獨立之佐證(不否決,由審計判定)`
            assert(rowOfBrief(2).includes(`| 自報 S 34.2 與重跑 33.7 不符;${tw2} |`), rowOfBrief(2))
            assert(rowOfBrief(4).includes(tw4), rowOfBrief(4))
            assert(!rowOfBrief(3).includes('提示(選集與他節點相同)'), '3 之正本未與他節點之列相同')
            //處置之後: 2 之提示仍在; 4 之對方(5)已刪除 ⇒ 移除
            assert.deepEqual(x.hintsOf(2), [tw2])
            assert.deepEqual(x.docOf(2).harness.checks.issues, ['自報 S 34.2 與重跑 33.7 不符', tw2], '置於末尾、其餘照留')
            assert.deepEqual(x.treeIssues(2), ['自報 S 34.2 與重跑 33.7 不符', tw2], '樹之 raw.issues 同一份')
            assert(x.mdOf(2).split('\n').some((l) => l.startsWith('- 迴圈檢查: ') && l.includes(tw2)), '節點文件(.md)之迴圈檢查')
            assert.deepEqual(x.hintsOf(4), [], '對方刪除後移除')
            assert.strictEqual(x.P.records.getNodeDoc(x.ids[5]), null, '鑑別前提: 5 已刪除')
            //較早之輪之節點(1: 單峰交付)不在本輪之輪末重寫
            assert.equal(x.jsonText(1), before1)
            //看板(輪末重產): 2 之臂標「選集與他節點相同」; 1 未重產 ⇒ 無「單峰交付」(採納後依證據重算 S, 只核臂與起點兩欄)
            let board = x.rd('ARMS_BOARD.md')
            assert(board.split('\n').some((l) => l.startsWith(`| \`${x.ids[2]}\` | A02_ntPit + D27_dedup 選集與他節點相同 | 無 | **`)), board)
            assert(board.split('\n').some((l) => l.startsWith(`| \`${x.ids[4]}\` | C19_jaccard | 無 | **`)), '4 之提示已移除 ⇒ 不標')
            assert(!board.includes('單峰交付'))
        })

        it('--mode validate 之重掃(rescanTraces)對全樹重產;看板之標記與表前一段;再掃不重寫;樹上皆無者看板不含任一字樣、表頭為改前原文', () => {
            let x = mk()
            let j6 = x.jsonText(6)
            assert.equal(x.P.rescanTraces(), 3, '1(單峰交付)、2、4(選集與他節點相同)')
            assert.deepEqual(x.hintsOf(1), [PEAK_TXT(41.3, 6, 8.9)])
            assert.deepEqual([x.hintsOf(3), x.hintsOf(5), x.hintsOf(6)], [[], [], []], '3 與 5 之正本未出現於他節點之列(提示掛在交付版相同之一方)')
            assert.equal(x.jsonText(6), j6, '未觸發之節點文件不重寫(6 之 control.mjs 之列 = 2 之交付版, 參考檔不計)')
            assert.equal(x.P.rescanTraces(), 0, '再掃不重寫')
            x.P.writeBoard()
            let board = x.rd('ARMS_BOARD.md')
            let ls = board.split('\n')
            assert(ls.some((l) => l.startsWith(`| \`${x.ids[1]}\` | A01_nt | 無 | **41.3** 單峰交付 |`)), '「S」一欄之標記')
            assert(ls.some((l) => l.startsWith(`| \`${x.ids[4]}\` | C19_jaccard 選集與他節點相同 | 無 | **14.6** |`)), '「臂」一欄之標記')
            assert.equal(ls.filter((l) => l.startsWith('「S」一欄標「單峰交付」者:')).length, 1)
            //表前之一段: 提示之內容去掉標頭與「不否決」之註(字面值)
            assert(ls.includes(`「S」一欄標「單峰交付」者:迴圈檢查列「提示(單峰交付)」之節點 —— 交付版之 S 為多次完整評估中之孤立高點(只提示、不否決;以鄰點與多抽之重放判其是否偶然):\`${id8(x, 1)}\`(交付版之 S 41.3 為完整評估之 6 個相異選集(選集指紋)中之最高者,其餘 5 個之 S 之中位 8.9(遠低於交付版)⇒ 交付版之 S 可能只是多次試驗中之最大值;以鄰點(鄰近參數之版本)與多抽之重放(換亂數種子與同分次序)判其是否偶然)。`))
            assert.equal(ls.filter((l) => l.startsWith('「臂」一欄標「選集與他節點相同」者:')).length, 1)
            assert(ls.find((l) => l.startsWith('「臂」一欄標「選集與他節點相同」者:')).includes(`\`${id8(x, 2)}\`(交付版之選集與 ${id8(x, 3)}/try_q.mjs 之完整評估逐位相同`))
            //未觸發之樹(只留 6): 看板不含任一字樣; 表頭為改前原文(1.0.36)
            let y = mk({ nodes: [N[5]] })
            assert.equal(y.P.rescanTraces(), 0)
            y.P.writeBoard()
            let b0 = y.rd('ARMS_BOARD.md')
            assert(!/單峰交付|選集與他節點相同/.test(b0))
            assert(b0.split('\n').includes('| 節點 | 臂 | 起點 | S | 最差相位 | 七相位平均 | 階梯 | 否決 | 虛無均 | 超額 | z | 虛無 p | 同訊號量超額 / p | 同活躍度超額 / p | 組成對照之超額 / p / 可重現 | 幾何對照之超額 / p | 換種子與同分次序之 S | 正本與重放之 S 之均;超額之均(組成對照 / 近期活躍度版) | 擴充診斷之看板值 | 每隻訊號數 | 做多比例 | 下單之做空比例(訓練期 / 回測期) | 月均單 | 最大持倉 | 選集大小 | 可信度 | 輪 | 成品之機制(自述) |'))
            assert(b0.split('\n').some((l) => l.startsWith(`| \`${y.ids[6]}\` | A04_act | 無 | **8.8** |`)))
        })

        it('reverify 之後依現行之正本之指紋重產(指紋改變 ⇒ 舊提示移除;迴圈檢查之其餘項照留)', async () => {
            let x = mk()
            x.P.rescanTraces()
            assert.equal(x.hintsOf(1).length, 1)
            //模擬評估器改版後之重跑使正本之指紋改變(工作夾無 pick.mjs ⇒ reverifyAll 不重跑, 只走其後之重產)
            let d1 = x.docOf(1)
            d1.harness.fingerprint = 'k1-new'
            x.P.records.putNodeDoc(d1)
            let j6 = x.jsonText(6)
            await x.P.reverifyAll({ why: '合成' })
            assert.equal(x.jsonText(6), j6, '提示無變動之節點不重寫')
            assert.deepEqual(x.hintsOf(1), [])
            assert.deepEqual(x.docOf(1).harness.checks.issues, ['自報 S 41.8 與重跑 41.3 不符'])
            assert.deepEqual(x.treeIssues(1), ['自報 S 41.8 與重跑 41.3 不符'])
            assert.equal(x.hintsOf(2).length, 1, '其餘節點照舊')
        })

        it('節點文件已寫而樹之更新拋錯 ⇒ 該次拋出(呼叫點只記錄);再呼叫時樹補上(文件與樹之提示同一份),再呼叫不重寫', () => {
            //規格(R-REC-44 ⑦): 節點文件之迴圈檢查與樹之 raw.issues 同一份(看板與共同儲存區之 status.issues 讀樹); 各自有變動才寫
            let x = mk()
            let store = x.P.rsi.store
            let orig = store.updateNode
            let boom = true
            store.updateNode = (...a) => {
                if (boom) {
                    throw new Error('合成之樹寫入失敗')
                }
                return orig.apply(store, a)
            }
            try {
                assert.throws(() => x.P.refreshEvalHints([x.ids[1]]), /合成之樹寫入失敗/)
                assert.equal(x.hintsOf(1).length, 1, '文件已寫')
                assert.equal(x.treeIssues(1).filter(isEvalHint).length, 0, '樹未寫')
                boom = false
                assert.equal(x.P.refreshEvalHints([x.ids[1]]), 1, '只補樹')
                assert.deepEqual(x.treeIssues(1).filter(isEvalHint), x.hintsOf(1), '文件與樹同一份')
                assert.equal(x.P.refreshEvalHints([x.ids[1]]), 0, '再呼叫不重寫')
            }
            finally {
                store.updateNode = orig
            }
        })

        it('提示之字串與看板之段落不列門檻之值(節點讀得到;以門檻之常數動態比對)', () => {
            //節點之事實不與門檻之值相同之合成資料: 相異 8 個、其餘 7 個、交付版 41.3、中位 3.7
            let nodes = [{ k: 1, arms: ['A01_nt'], round: 1, S: 41.3, fp: 'k1-d', log: () => peakLines('k1-d', 41.3, [3.7, -12.4, 8.9, 15.2, 20.6, 1.1, 2.2]) }, N[1], N[2]]
            let x = mk({ nodes })
            x.P.rescanTraces()
            x.P.writeBoard()
            let board = x.rd('ARMS_BOARD.md').split('\n')
            let texts = [...x.hintsOf(1), ...x.hintsOf(2), ...board.filter((l) => l.startsWith('「S」一欄標「單峰交付」者:') || l.startsWith('「臂」一欄標「選集與他節點相同」者:'))]
            assert.equal(texts.length, 4, '鑑別前提: 兩條提示與看板之兩段皆產生')
            assert(texts[0].includes('其餘 7 個之 S 之中位 3.7'), texts[0])
            //門檻之值(與其百分比之寫法)以常數組出; 數字之字樣先去掉節點 id、臂名與檔名
            let banned = new Set([...Object.values(EVAL_HINT).map(String), String(EVAL_HINT.peakRatio * 100)])
            let numsOf = (s) => s.replace(/\b[0-9a-f]{8,16}\b/g, '').replace(/\b[A-Z]\d{2}_\w+/g, '').replace(/[\w-]+\.mjs/g, '').match(/\d+(?:\.\d+)?/g) || []
            for (let s of texts) {
                assert.deepEqual(numsOf(s).filter((v) => banned.has(v)), [], s)
            }
            //鑑別前提: 以門檻之值寫成之句(改前之寫法)會被此檢查抓到
            assert(numsOf(`(不到交付版之 S 之 ${EVAL_HINT.peakRatio} 倍)`).some((v) => banned.has(v)))
            assert(numsOf(`(完整評估之相異選集 ≥ ${EVAL_HINT.peakMinSel} 個)`).some((v) => banned.has(v)))
        })

        it('判定拋錯時各呼叫點只記錄、主流程照常:validate 之重掃(操作掃描照常、既有之提示照留)、reverify 之後(看板照常重產)、輪末鉤子之派做夢之前與處置之後(做夢照常)', async () => {
            let x = mk()
            x.P.rescanTraces()
            let hint1 = x.hintsOf(1)
            assert.equal(hint1.length, 1, '鑑別前提: 正常之判定寫入了提示')
            //節點 1 之文件加一條過時之掃描項(重掃時應被現行之掃描結果取代)
            let d1 = x.docOf(1)
            d1.harness.checks.issues = ['自報 S 41.8 與重跑 41.3 不符', '觸及禁區: 合成之過時之掃描項', ...hint1]
            x.P.records.putNodeDoc(d1)
            let boom = () => {
                throw new Error('合成之判定失敗')
            }
            let P2 = x.reopen({ evalHints: boom })
            //重掃
            assert.equal(P2.rescanTraces(), 1)
            assert.deepEqual(x.docOf(1).harness.checks.issues, ['自報 S 41.8 與重跑 41.3 不符', ...hint1], '掃描項照常取代、既有之提示照留(仍在末尾)')
            assert.deepEqual(x.treeIssues(1), ['自報 S 41.8 與重跑 41.3 不符', ...hint1], '樹之既有之提示照留')
            assert.equal(x.hintsOf(2).length, 1, '他節點之提示照留')
            assert(x.logText().includes('迴圈檢查之提示(單峰交付 / 選集與他節點相同)未能產生(重掃;既有之兩條提示照留,操作掃描照常): 合成之判定失敗'))
            //reverify 之後: 不中斷, 看板照常重產
            assert.equal(fs.existsSync(path.join(x.st.rsi.root, 'ARMS_BOARD.md')), false, '鑑別前提: 看板尚未產生')
            assert.deepEqual(await P2.reverifyAll({ why: '合成' }), [])
            assert.equal(fs.existsSync(path.join(x.st.rsi.root, 'ARMS_BOARD.md')), true)
            assert(x.logText().includes('未能產生(reverify 之後;重跑之結果已寫入,看板照常重產): 合成之判定失敗'))
            //輪末鉤子: 做夢照常派出並套用; 兩處各記一次
            let r2 = N.filter((n) => n.round === 2).map((n) => P2.rsi.store.getNode(x.ids[n.k]))
            let hk = await P2.domain.hooks.afterRound({ round: 2, nodes: r2 })
            assert.equal(x.briefs.length, 1)
            assert(hk && hk.dream, '做夢已交付')
            assert(x.logText().includes('未能產生(派做夢之前;不影響輪次): 合成之判定失敗'))
            assert(x.logText().includes('未能產生(做夢之處置之後;不影響輪次): 合成之判定失敗'))
            assert.equal(x.hintsOf(2).length, 1, '既有之提示照留')
        })

        it('tools/scanCheck.mjs(唯讀之對照):與寫回同一判定 —— 未寫回者列「不同」與現行規則之提示,寫回後「相同」;不改任何紀錄', () => {
            let x = mk()
            //子行程之專案根 = 合成專案(設定由參考設定改寫; 資源閘關閉)
            let stJ = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            stJ.eval = { ...stJ.eval, ledgerDir: './ledger' }
            stJ.resources = {}
            fs.writeFileSync(path.join(x.d, 'settings.json'), JSON.stringify(stJ, null, 1), 'utf8')
            let run = () => spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'scanCheck.mjs')], { cwd: x.d, env: { ...process.env, ARSI_ROOT: x.d }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
            let snap = () => fs.readdirSync(x.st.records.nodeDir).sort().map((f) => fs.readFileSync(path.join(x.st.records.nodeDir, f), 'utf8')).join('\n')
            let s0 = snap()
            let r = run()
            assert.equal(r.status, 0, r.stderr)
            let line1 = r.stdout.split('\n').find((l) => l.startsWith(`${id8(x, 1)} r1 `))
            assert(line1.startsWith(`${id8(x, 1)} r1 **不同** | 現行規則 1 項: ${PEAK_TXT(41.3, 6, 8.9).slice(0, 80)} | 節點文件內 0 項: 無`), line1)
            assert(r.stdout.includes(`${id8(x, 6)} r1 相同 | 現行規則 0 項`), '未觸發者照舊')
            assert(/與節點文件不同者 3 份/.test(r.stdout), r.stdout)
            assert.equal(snap(), s0, '唯讀')
            x.P.rescanTraces()
            let r2 = run()
            assert(/與節點文件不同者 0 份/.test(r2.stdout), r2.stdout)
            assert(r2.stdout.includes(`${id8(x, 1)} r1 相同 | 現行規則 1 項`))
        })
    })
})
