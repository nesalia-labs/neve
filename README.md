# neve

Monorepo for the nesalia-labs agents and apps.

## Apps

- `apps/ghostwriter` — research-grounded writing assistant (eve agent)

## Layout

```
neve/
├── .gitignore
├── README.md
└── apps/
    └── ghostwriter/
        ├── agent/         # eve agent code
        ├── package.json
        └── ...
```

Each app is a standalone npm package. Run one with:

```bash
cd apps/<name>
npm install
npm run dev
```
