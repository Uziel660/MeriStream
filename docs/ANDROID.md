# MeriStream Android

Este port empaqueta únicamente el frontend de MeriStream. El backend, PostgreSQL,
resolución JIT, proxy de streams, subtítulos, autenticación y Watch Party siguen
ejecutándose en el servidor existente.

## Backend

La app usa `VITE_API_ORIGIN`. El valor de producción usado por el workflow es:

```text
https://stream.merith.me
```

Puedes cambiarlo antes de compilar:

```bash
VITE_API_ORIGIN=https://tu-servidor.example npm run build:client
```

## Crear el proyecto Android localmente

Requisitos: Node 22+, JDK 21 y Android Studio/Android SDK.

```bash
npm ci
npm run android:deps
npm run build:client
npm run android:add
npm run android:sync
npm run android:open
```

Luego compila o ejecuta desde Android Studio. Para regenerar el frontend dentro
del proyecto Android tras cambios en React:

```bash
npm run android:sync
```

## Arquitectura

- React/Vite se compila a `dist/`.
- Capacitor empaqueta `dist/` dentro del APK.
- `src/utils/runtime.ts` convierte rutas relativas de API al servidor remoto
  cuando la app corre como shell nativo.
- Watch Party cambia automáticamente de `https://` a `wss://`.
- El navegador normal conserva las rutas relativas actuales, por lo que el
  frontend web existente continúa funcionando igual.

La app no incluye Node.js, Prisma ni PostgreSQL dentro del dispositivo.
