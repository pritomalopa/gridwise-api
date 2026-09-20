'use strict';

/**
 * Request validation for POST /optimize-energy.
 * Returns { ok, error, status } — status 400 for malformed, 422 for semantic.
 */

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  }
  const { scenario_id, operator_notes, hours, battery } = body;

  if (typeof scenario_id !== 'string' || scenario_id.trim() === '') {
    return { ok: false, status: 400, error: 'scenario_id must be a non-empty string.' };
  }
  if (!Array.isArray(operator_notes) || operator_notes.length < 1 || operator_notes.length > 3) {
    return { ok: false, status: 400, error: 'operator_notes must be an array of 1-3 strings.' };
  }
  for (let i = 0; i < operator_notes.length; i++) {
    if (typeof operator_notes[i] !== 'string' || operator_notes[i].trim() === '') {
      return { ok: false, status: 400, error: `operator_notes[${i}] must be a non-empty string.` };
    }
  }
  if (!Array.isArray(hours) || hours.length !== 24) {
    return { ok: false, status: 400, error: 'hours must be an array of exactly 24 entries.' };
  }
  const seen = new Set();
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    if (!h || typeof h !== 'object') {
      return { ok: false, status: 400, error: `hours[${i}] must be an object.` };
    }
    if (!Number.isInteger(h.hour) || h.hour < 0 || h.hour > 23) {
      return { ok: false, status: 400, error: `hours[${i}].hour must be an integer 0-23.` };
    }
    if (seen.has(h.hour)) {
      return { ok: false, status: 422, error: 'hours must contain unique hour values 0-23.' };
    }
    seen.add(h.hour);
    if (!isFiniteNumber(h.demand_kwh) || h.demand_kwh < 0) {
      return { ok: false, status: 422, error: `hours[${i}].demand_kwh must be a non-negative finite number.` };
    }
    if (!isFiniteNumber(h.solar_kwh) || h.solar_kwh < 0) {
      return { ok: false, status: 422, error: `hours[${i}].solar_kwh must be a non-negative finite number.` };
    }
    if (!isFiniteNumber(h.tariff_bdt_per_kwh) || h.tariff_bdt_per_kwh < 0) {
      return { ok: false, status: 422, error: `hours[${i}].tariff_bdt_per_kwh must be a non-negative finite number.` };
    }
  }
  if (!battery || typeof battery !== 'object' || Array.isArray(battery)) {
    return { ok: false, status: 400, error: 'battery must be an object.' };
  }
  const bFields = ['capacity_kwh', 'initial_energy_kwh', 'minimum_energy_kwh', 'max_charge_kwh_per_hour', 'max_discharge_kwh_per_hour'];
  for (const f of bFields) {
    if (!isFiniteNumber(battery[f]) || battery[f] < 0) {
      return { ok: false, status: 422, error: `battery.${f} must be a non-negative finite number.` };
    }
  }
  if (battery.initial_energy_kwh > battery.capacity_kwh) {
    return { ok: false, status: 422, error: 'battery.initial_energy_kwh must not exceed capacity_kwh.' };
  }
  if (battery.minimum_energy_kwh > battery.capacity_kwh) {
    return { ok: false, status: 422, error: 'battery.minimum_energy_kwh must not exceed capacity_kwh.' };
  }
  return { ok: true };
}

module.exports = { validateRequest };
