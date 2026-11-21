//變異工具(mutateBar.mjs、mutateStart.mjs)共用: 變異表之編號唯一之核對(Gitea #199 之另見 2; 規則 R-PKG-9)
//  編號重複時 --only <編號> 會同時植入兩項、結果表亦無從分辨; 錨點之核對(--check)不會偵出此類錯, 故 --check 另以本函數核對

//dupIdsOf, 變異表中重複之編號(依其第二次出現之序, 每個編號只列一次; 純函數): rows = 變異之陣列, 每項之第 0 欄為編號; 無重複回 []
export let dupIdsOf = (rows) => {
    let seen = new Set()
    let dup = []
    for (let r of rows) {
        let id = Array.isArray(r) ? r[0] : undefined
        if (seen.has(id) && !dup.includes(id)) {
            dup.push(id)
        }
        seen.add(id)
    }
    return dup
}
