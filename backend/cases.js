'use strict';

const { createClient } = require('@supabase/supabase-js');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function createCaseRouter({ config, auth, fetchWalletScore }) {
  const service = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function listCases(req, res) {
    const status = req.query.status;
    if (status && !['open', 'dismissed', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid case status.' });
    let query = service.from('flagged_cases').select('*').eq('organization_id', req.auth.activeOrganization.organization_id).order('flagged_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return res.status(503).json({ error: 'Unable to load cases.' });
    return res.json({ cases: data });
  }

  async function createCase(req, res) {
    const address = typeof req.body?.walletAddress === 'string' ? req.body.walletAddress.toLowerCase() : '';
    if (!ADDRESS.test(address)) return res.status(400).json({ error: 'A valid Ethereum walletAddress is required.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 5000) || null : null;
    try {
      const current = await fetchWalletScore(address, req.auth.token);
      const snapshot = { address: current.address, balanceEth: current.balanceEth, totalTransfers: current.totalTransfers, transfers: current.transfers, scoring: current.scoring };
      const { data, error } = await service.rpc('create_flagged_case', {
        p_organization_id: req.auth.activeOrganization.organization_id, p_wallet_address: address, p_chain: 'ethereum-mainnet',
        p_risk_score: current.scoring.score, p_risk_band: current.scoring.band, p_risk_flags: current.scoring.flags,
        p_wallet_snapshot: snapshot, p_scoring_version: 'riskScoring.js-v1', p_sanctions_source: current.sanctions.source,
        p_sanctions_refreshed_at: current.sanctions.refreshedAt, p_flagged_by: req.auth.user.id, p_case_note: note,
      });
      if (error?.code === '23505') return res.status(409).json({ error: 'This wallet already has an open case in this organization.' });
      if (error) throw error;
      return res.status(201).json({ case: data });
    } catch (error) {
      console.error('[cases] create failed:', error.message);
      return res.status(502).json({ error: 'Unable to create a case from the current wallet analysis.' });
    }
  }

  async function getCase(req, res) {
    const { data, error } = await service.from('flagged_cases').select('*').eq('id', req.params.caseId).eq('organization_id', req.auth.activeOrganization.organization_id).maybeSingle();
    if (error) return res.status(503).json({ error: 'Unable to load case.' });
    if (!data) return res.status(404).json({ error: 'Case not found.' });
    const events = await service.from('case_events').select('*').eq('case_id', data.id).eq('organization_id', data.organization_id).order('created_at');
    if (events.error) return res.status(503).json({ error: 'Unable to load case history.' });
    return res.json({ case: data, events: events.data });
  }

  async function transitionCase(req, res) {
    const status = req.body?.status;
    if (!['dismissed', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be dismissed or closed.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 5000) || null : null;
    const { data, error } = await service.rpc('transition_flagged_case', {
      p_case_id: req.params.caseId, p_organization_id: req.auth.activeOrganization.organization_id,
      p_new_status: status, p_actor_user_id: req.auth.user.id, p_event_note: note,
    });
    if (error) return res.status(409).json({ error: 'Only an open case in your organization can be transitioned.' });
    return res.json({ case: data });
  }

  return { listCases, createCase, getCase, transitionCase, guard: [auth.requireAuthenticatedSession, auth.requireActiveOrganization] };
}

module.exports = { createCaseRouter };
