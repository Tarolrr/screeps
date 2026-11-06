#!/usr/bin/env python3
"""Render the analytical examples; optional dependency: matplotlib 3.10.x."""
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt

from calculations import haul, investment


def main():
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10,
                         'svg.hashsalt': 'screeps-strategy-v1'})
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), layout='constrained')
    ts = list(range(0, 1001, 5))
    outputs = [investment(5000, 5, 500, 50, 2, t) for t in ts]
    ax = axes[0]
    ax.plot(ts, [o['direct_progress'] for o in outputs], label='Сразу в контроллер', color='#33658a', lw=2.2)
    ax.plot(ts, [o['invested_progress'] for o in outputs], label='Сначала инвестиция', color='#d16b32', lw=2.2)
    ax.axvline(400, color='#777777', linestyle=':', lw=1)
    ax.annotate('Равенство: 400 тиков', (400, 2000), (430, 1200),
                arrowprops={'arrowstyle': '->', 'color': '#777777'}, fontsize=9)
    ax.set(title='Цена ранней инвестиции', xlabel='Тики от одинакового старта', ylabel='Прогресс контроллера')
    ax.legend(loc='upper left', frameon=False)
    ax.text(0.02, -0.25, 'g=5, I=500, накопление 100, запуск +50, прирост +2/тик',
            transform=ax.transAxes, fontsize=8)

    ax = axes[1]
    distances = list(range(5, 61))
    for terrain, name, color in [(1, 'Дорога', '#3f8066'), (2, 'Равнина', '#33658a'), (10, 'Болото', '#a06d42')]:
        ax.plot(distances, [haul(d, terrain)['capacity'] for d in distances], label=name, color=color, lw=2.2)
    ax.axhline(10, color='#777777', linestyle=':', lw=1, label='Поток источника 10/тик')
    ax.set(title='Перевозчик 10 CARRY + 5 MOVE', xlabel='Длина пути в одну сторону, клеток',
           ylabel='Расчётная транспортная мощность, энергия/тик', ylim=(0, 46))
    ax.legend(loc='upper right', frameon=False)
    ax.text(0.02, -0.25, 'Пустой обратный путь; +2 тика обслуживания; без пробок',
            transform=ax.transAxes, fontsize=8)
    for ax in axes:
        ax.grid(alpha=0.18)
        ax.spines[['top', 'right']].set_visible(False)
    fig.suptitle('Аналитические сценарии, не результаты игрового эксперимента', fontsize=13)
    directory = Path(__file__).resolve().parent / 'assets'
    directory.mkdir(exist_ok=True)
    svg_path = directory / 'tradeoffs.svg'
    fig.savefig(svg_path, metadata={'Date': None})
    # Matplotlib emits trailing spaces inside SVG path data; keep the artifact
    # whitespace-clean without changing the plot or its geometry.
    svg_path.write_text('\n'.join(line.rstrip() for line in svg_path.read_text().splitlines()) + '\n')
    fig.savefig(directory / 'tradeoffs.png', dpi=160, metadata={'Software': 'matplotlib'})
    plt.close(fig)


if __name__ == '__main__':
    main()
