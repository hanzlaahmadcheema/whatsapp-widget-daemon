# Contributing

Thanks for your interest in contributing to whatsapp-widget-daemon!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b feature/your-feature`

## Development

```bash
# Run in development mode (hot reload via tsx)
npm run dev

# Type-check without emitting
npm run lint

# Build for production
npm run build

# Run all tests
npm test
```

## Code Style

- TypeScript with strict mode
- Use the `pino` logger (`src/utils/logger.ts`) — no `console.log` in daemon code
- Follow existing patterns for IPC events and state management
- Keep functions focused and well-named

## Testing

Tests live in `test/` and use Node.js built-in test runner (`node:test`):

```bash
npm test
```

When adding new features, add or extend tests to cover the behavior. Test files follow the naming pattern `*.test.ts`.

## Pull Requests

1. Keep PRs focused on a single change
2. Ensure `npm run lint` and `npm test` pass
3. Write a clear PR description explaining what changed and why
4. Reference any related issues

## Reporting Issues

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Node.js version, daemon version)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
