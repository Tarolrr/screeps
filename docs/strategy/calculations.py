#!/usr/bin/env python3
"""Deterministic analytical examples; no game state or third-party dependencies."""
import json
import math


def travel(distance, terrain, carry, move, loaded):
    if distance < 0 or terrain not in (1, 2, 10) or carry < 0 or move <= 0:
        raise ValueError('invalid route or body')
    weight = carry if loaded else 0
    return distance * max(1, math.ceil(terrain * weight / (2 * move)))


def haul(distance, terrain, carry=10, move=5, handling=2):
    approach = travel(distance, terrain, carry, move, False)
    if approach >= 1500 or handling < 0:
        raise ValueError('hauler cannot reach destination within lifetime')
    cycle = travel(distance, terrain, carry, move, True) + approach + handling
    if not cycle:
        raise ValueError('empty cycle')
    return dict(cycle=cycle, capacity=50 * carry / cycle, cost=50 * (carry + move),
                replacement_per_tick=50 * (carry + move) / (1500 - approach),
                spawn_fraction=3 * (carry + move) / (1500 - approach))


def investment(goal, baseline, cost, delay, increment, horizon):
    if goal < 0 or baseline <= 0 or min(cost, delay, increment, horizon) < 0:
        raise ValueError('invalid economic parameters')
    tau = cost / baseline
    start = tau + delay
    # After saving, baseline resumes upgrading; then increment starts.
    if goal <= baseline * delay:
        finish = tau + goal / baseline if goal else 0
    else:
        finish = start + (goal - baseline * delay) / (baseline + increment)
    direct = baseline * horizon
    invested = baseline * max(0, horizon - tau) + increment * max(0, horizon - start)
    return dict(direct_ticks=goal / baseline, invested_ticks=finish, save_ticks=tau,
                benefit_start=start, finite_horizon_break_even=start + cost / increment if increment else None,
                horizon=horizon, direct_progress=direct, invested_progress=invested)


def body(budget, role):
    if role == 'mule':
        sets = min(budget // 150, 4)
        return {'cost': sets*150, 'work': 0, 'carry': sets*2, 'move': sets}
    if budget < 200:
        raise ValueError('body cannot be afforded')
    if role == 'builder':
        sets = min((budget-200)//200, 4)
        return {'cost':200+200*sets, 'work':1+sets, 'carry':1+sets, 'move':1+sets}
    cap = 700 if role == 'harvester' else 1000
    work = 1 + min((budget-200)//100, (cap-200)//100)
    return {'cost':100+work*100, 'work':work, 'carry':1, 'move':1}


def main():
    assert travel(10, 1, 10, 5, True) == 10
    assert travel(10, 2, 10, 5, True) == 20
    assert travel(10, 10, 10, 5, False) == 10
    assert haul(20, 1)['cycle'] == 42
    try:
        haul(1500, 1)
        raise AssertionError('unreachable accepted')
    except ValueError:
        pass
    assert investment(0, 5, 500, 50, 2, 50)['invested_ticks'] == 0
    assert investment(100, 5, 500, 50, 2, 50)['invested_ticks'] == 120
    assert investment(5000, 5, 500, 50, 0, 50)['finite_horizon_break_even'] is None
    assert investment(5000, 5, 500, 50, 2, 50)['invested_progress'] == 0
    assert abs(investment(5000, 5, 500, 50, 2, 400)['invested_progress'] - 2000) < 1e-9
    rows = {}
    for budget in (300, 550, 800, 1000):
        bodies = {role: body(budget, role) for role in ('harvester','mule','upgrader','builder')}
        total = sum(bodies[r]['cost']*n for r,n in [('harvester',2),('mule',6),('upgrader',2),('builder',1)])
        rows[str(budget)] = dict(bodies=bodies, fleet_cost=total, replacement_floor=total/1500,
                                 harvest_potential=min(20, 4*bodies['harvester']['work']),
                                 upgrade_work_potential=2*bodies['upgrader']['work'],
                                 role_cycle_harvest_potential=min(20, 2*(2*bodies['harvester']['work']*math.ceil(50/(2*bodies['harvester']['work']))/(math.ceil(50/(2*bodies['harvester']['work']))+1))))
    repair = 20*(0.001 + 0.001*15*2*(10/500))
    road_rate = 750/1480
    plain_efficient_rate = 1000/1480
    payoff = {'growth':[4000,-3000,-12000], 'fortify':[1800,1500,-2000],
              'raid':[1000,-500,-5000], 'scout':[3500,1000,-3000]}
    best = [max(values[i] for values in payoff.values()) for i in range(3)]
    regrets = {name:max(best[i]-value for i,value in enumerate(values)) for name,values in payoff.items()}
    worst = {name:min(values) for name,values in payoff.items()}
    assert regrets == {'growth':10000,'fortify':2200,'raid':3000,'scout':1000}
    assert max(worst, key=worst.get) == 'fortify' and min(regrets, key=regrets.get) == 'scout'
    hits = 600*100
    result = {
        'defense': {'tower_capacity':1000,'shot_cost':10,'shots_without_supply':100,
                    'two_towers_energy_per_tick':20,'two_sources_ideal_income_per_tick':20,
                    'rampart_initial_hits':1,'attack_damage_per_tick':600,'hold_ticks':100,
                    'required_hits':hits,'additional_hits':hits-1,
                    'minimum_work_repair_energy':math.ceil((hits-1)/100)},
        'game_theory_example': {'scenario_order':['calm','raid','war'],'payoffs':payoff,
                                'worst_payoffs':worst,'max_regret':regrets,
                                'maximin':'fortify','minimax_regret':'scout',
                                'strictly_dominated':{'raid':'fortify'}},
        'source': {'owned_or_reserved_per_tick': 10, 'neutral_per_tick': 5, 'work_for_full_owned': 5, 'work_for_full_neutral': 3},
        'miner_5work_1carry_3move': {'cost':700, 'travel_ticks':20, 'replacement_per_tick':700/1480, 'spawn_fraction':27/1480},
        'hauler_10carry_5move': {f'{name}_distance_{d}':haul(d,terrain) for name,terrain in [('road',1),('plain',2),('swamp',10)] for d in (10,20,40)},
        'investment': investment(5000,5,500,50,2,1000),
        'investment_sensitivity': {f'horizon_{h}':investment(5000,5,500,50,2,h) for h in (100,150,200,400,1000)},
        'investment_parameter_sensitivity': {f'cost_{c}_increment_{i}':investment(5000,5,c,50,i,1000) for c in (250,500,1000) for i in (0,1,2,4)},
        'remote_reserver_2claim_2move': {'cost':1300,'travel_ticks':50,'replacement_per_tick':1300/550,'spawn_fraction':12/550,'reservation_ticks_added_per_cycle':1100,'replacement_cycle_ticks':550,'one_source_increment_after_reserver':5-1300/550,'two_source_increment_after_reserver':10-1300/550},
        'emergency_policy': {'starter':200,'starter_extra':100,'miner':700,'hauler':750,'total':1750},
        'road_plain_20': {'construction_energy':6000,'repair_per_tick':repair,'trips_per_tick':10/500,'fixed_body_savings_per_tick':road_rate-repair,'fixed_body_payback':6000/(road_rate-repair),'efficient_body_savings_per_tick':plain_efficient_rate-road_rate-repair,'efficient_body_payback':6000/(plain_efficient_rate-road_rate-repair)},
        'dist2_fleet': rows,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
