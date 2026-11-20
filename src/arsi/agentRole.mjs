//agent 之角色之環境變數(規則 R-RUN-11): 派工器(makeDispatch)於節點與做夢之 agent 子行程設 ARSI_AGENT_ROLE = 'node' / 'dream'(只設於該次子行程, 不寫入本行程之環境);
//  agent 所起之一切指令皆繼承之 ⇒ 會寫專案之檔或起行程之進入檔與模式見之即拒跑(判定與表在領域層之 agentEntries.mjs); 未設(或為其他值)者行為不變
//  迴圈自己起之子行程(驗證之重跑、附算、檢定)之環境取自迴圈之行程, 迴圈之行程不帶此變數(由 agent 起迴圈者被拒)⇒ 不受影響
/**
 * agent 角色之環境變數名
 *
 * @type {String}
 */
let AGENT_ROLE_ENV = 'ARSI_AGENT_ROLE'
/**
 * 設定 agent 角色之環境變數之角色(派工之角色名)
 *
 * @type {Array<String>}
 */
let AGENT_ROLES = ['node', 'dream']

/**
 * 取目前行程之 agent 角色:環境變數 ARSI_AGENT_ROLE 為 'node' 或 'dream' 者回該值,其餘(未設、空字串、其他值)回 null
 *
 * @param {Object} [env=process.env] 輸入環境變數物件
 * @returns {String|null} 回傳 'node'、'dream' 或 null
 * @example
 * let role = agentRoleOf({ ARSI_AGENT_ROLE: 'node' })
 * // => 'node'
 */
let agentRoleOf = (env = process.env) => {
    let v = env && typeof env === 'object' ? env[AGENT_ROLE_ENV] : undefined
    return AGENT_ROLES.includes(v) ? v : null
}

/**
 * 派工時要併入 agent 子行程之環境變數(角色為 'node' / 'dream' 者回 { ARSI_AGENT_ROLE: 角色 },其餘回 null)
 *
 * @param {String} role 輸入派工之角色名
 * @returns {Object|null} 回傳環境變數物件或 null
 * @example
 * let env = agentEnvOf('dream')
 * // => { ARSI_AGENT_ROLE: 'dream' }
 */
let agentEnvOf = (role) => (AGENT_ROLES.includes(role) ? { [AGENT_ROLE_ENV]: role } : null)

export { AGENT_ROLE_ENV, AGENT_ROLES, agentRoleOf, agentEnvOf }
