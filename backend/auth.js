'use strict';

const { createClient } = require('@supabase/supabase-js');

function buildSupabaseClients(config) {
  const clientOptions = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  };

  return {
    publicAuth: createClient(config.supabaseUrl, config.supabaseAnonKey, clientOptions),
    service: createClient(config.supabaseUrl, config.supabaseServiceRoleKey, clientOptions),
  };
}

function extractBearerToken(req) {
  const authorization = req.get('authorization');
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function selectActiveOrganization(memberships, requestedOrganizationId) {
  if (requestedOrganizationId) {
    return memberships.find(membership => membership.organization_id === requestedOrganizationId) || null;
  }
  return memberships.length === 1 ? memberships[0] : null;
}

function isInvalidSessionError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return error?.status === 401
    || ['invalid_token', 'invalid_jwt', 'bad_jwt', 'token_expired'].includes(code)
    || message.includes('invalid jwt')
    || message.includes('jwt expired');
}

function createAuthMiddleware(config) {
  const clients = buildSupabaseClients(config);

  async function loadMemberships(userId) {
    const { data: memberships, error } = await clients.service
      .from('organization_memberships')
      .select('organization_id, role, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('organization_id', { ascending: true });

    if (error) throw new Error(`Membership lookup failed: ${error.message}`);
    if (!memberships?.length) return [];
    const organizationIds = memberships.map(membership => membership.organization_id);
    const { data: organizations, error: organizationError } = await clients.service
      .from('organizations')
      .select('id, name')
      .in('id', organizationIds);
    if (organizationError) throw new Error(`Organization lookup failed: ${organizationError.message}`);
    const namesById = new Map((organizations || []).map(organization => [organization.id, organization.name]));
    return memberships.map(membership => ({ ...membership, organization_name: namesById.get(membership.organization_id) || null }));
  }

  async function attachSession(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) return next();

    try {
      const { data, error } = await clients.publicAuth.auth.getUser(token);
      if (error && isInvalidSessionError(error)) {
        req.authError = 'Invalid or expired authenticated session.';
        return next();
      }
      if (error) throw new Error(`Session verification failed: ${error.message}`);
      if (!data?.user) {
        req.authError = 'Invalid or expired authenticated session.';
        return next();
      }

      const memberships = await loadMemberships(data.user.id);
      const requestedOrganizationId = req.get('x-flowtrace-organization-id');
      const activeOrganization = selectActiveOrganization(memberships, requestedOrganizationId);
      req.auth = {
        token,
        user: data.user,
        memberships,
        activeOrganization,
        invalidOrganizationSelection: Boolean(requestedOrganizationId && !activeOrganization),
      };
      return next();
    } catch (error) {
      console.error('[auth] session verification failed:', error.message);
      return res.status(503).json({ error: 'Authentication service is unavailable.' });
    }
  }

  function requireAuthenticatedSession(req, res, next) {
    if (req.authError) return res.status(401).json({ error: req.authError });
    if (!req.auth?.user) return res.status(401).json({ error: 'An authenticated session is required.' });
    return next();
  }

  function requireActiveMembership(req, res, next) {
    if (!req.auth?.memberships?.length) {
      return res.status(403).json({ error: 'Your account does not have an active organization membership.' });
    }
    if (req.auth.invalidOrganizationSelection) {
      return res.status(403).json({ error: 'You are not an active member of the requested organization.' });
    }
    return next();
  }

  function requireActiveOrganization(req, res, next) {
    const membershipResult = requireActiveMembership(req, res, () => {});
    if (membershipResult) return membershipResult;
    if (!req.auth.activeOrganization) {
      return res.status(400).json({ error: 'Select an active organization before accessing cases.' });
    }
    return next();
  }

  function requireAnalysisSession(req, res, next) {
    if (req.authError) return res.status(401).json({ error: req.authError });
    if (config.mode === 'production') {
      return requireAuthenticatedSession(req, res, () => requireActiveMembership(req, res, next));
    }
    return next();
  }

  async function claimPendingInvitations(req, res) {
    const userClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${req.auth.token}` } },
    });
    const { data, error } = await userClient.rpc('claim_pending_organization_invitations');
    if (error) {
      console.error('[auth] invitation claim failed:', error.message);
      return res.status(400).json({ error: 'Unable to claim a pending invitation.' });
    }

    try {
      const memberships = await loadMemberships(req.auth.user.id);
      return res.json({ claimed: data, memberships });
    } catch (lookupError) {
      console.error('[auth] membership reload failed:', lookupError.message);
      return res.status(503).json({ error: 'Invitation claimed, but membership verification is unavailable.' });
    }
  }

  return {
    attachSession,
    requireAuthenticatedSession,
    requireActiveMembership,
    requireActiveOrganization,
    requireAnalysisSession,
    claimPendingInvitations,
  };
}

module.exports = { createAuthMiddleware };
