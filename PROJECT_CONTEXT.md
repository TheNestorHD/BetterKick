# BetterKick — Contexto central del ecosistema

> **Actualizado:** 2026-11-23  
> **Alcance:** Documento de coordinación para humanos e instancias de IA. No sustituye a `README.md` ni a `ROADMAP.md`.  
> **Objetivo a largo plazo:** una gran actualización modular de **BetterKick** que integre funciones desarrolladas y validadas de forma independiente.

## 1. Visión y normas de trabajo

BetterKick es la extensión principal para mejorar la experiencia de Kick, tanto para espectadores como para moderadores y streamers. En vez de incorporar todas las ideas de golpe al repositorio principal, se construirán primero en **repositorios separados**, con versiones, pruebas, documentación y seguimiento de errores independientes.

**Secuencia acordada:** idea → especificación → prototipo separado → pruebas simuladas → pruebas reales (incluidos directos de Eskrotos cuando corresponda) → corrección y estabilización → evaluación de integración → futura mega actualización de BetterKick.

La integración no está autorizada implícitamente por el hecho de que exista un prototipo. Se debe acordar expresamente cuándo tocar el código de BetterKick. Mantener funciones anteriores y datos de usuarios es prioritario.

## 2. Repositorios

| Proyecto | Repositorio | Estado al 2026-11-23 | Función |
| --- | --- | --- | --- |
| **BetterKick (principal)** | [TheNestorHD/BetterKick](https://github.com/TheNestorHD/BetterKick) | Extensión base existente | Integrará módulos estables en una actualización posterior |
| **BetterKick LiveMarkers** | [TheNestorHD/BetterKick-livemarkers](https://github.com/TheNestorHD/BetterKick-livemarkers) | Beta independiente **0.1.10**, probada en Kick | Marcadores de momentos en directo y VOD, contribuciones de la comunidad |
| **BetterKick ModAnalytics** | [TheNestorHD/BetterKick-modanalytics](https://github.com/TheNestorHD/BetterKick-modanalytics) | Desarrollo privado **0.1.0**, pruebas automatizadas y de navegador con fixtures | Métricas locales en el dashboard de moderación |
| **BetterKick FollowGuard** | [TheNestorHD/BetterKick-followguard](https://github.com/TheNestorHD/BetterKick-followguard) | Desarrollo privado **0.1.0**, captura en directo pendiente de validar | Registro local de oleadas de seguidores y exportación CSV para revisión humana |

BetterKick es el repositorio público del ecosistema. LiveMarkers, ModAnalytics y FollowGuard permanecen privados durante el desarrollo y se instalan por separado. Los dos nuevos módulos funcionan dentro del navegador, con historial por instalación, cero telemetría y consultas directas a Kick. Para evaluar su integración falta contrastar las métricas y la entrega de eventos con un dashboard autorizado durante un directo, además de probar la convivencia de los controles en distintas distribuciones.

**Ideas exploratorias, sin repositorios confirmados ni implementaciones:** *Clip Manager* (curaduría y preparación de clips) y *Mod Assistant* (ayuda a moderadores con detección y alertas, sin sanciones automáticas por defecto). Crear entradas solo cuando el proyecto exista.

> Nota: LiveMarkers fue creado inicialmente en un entorno de trabajo separado y probado como extensión independiente antes de disponer de su repositorio. En el proyecto GitHub de LiveMarkers consultar su propio `PROJECT_CONTEXT.md` para el estado técnico y la configuración actual. El repositorio de LiveMarkers fue creado como **privado**; sus enlaces solo son visibles para usuarios autorizados hasta que su propietario decida lo contrario.

## 3. Mejoras ya presentes en la extensión principal

Consultar el código fuente y los documentos de su repositorio para verificar el estado exacto. Se ha trabajado, entre otras cosas, con descarga de VOD y streams, conversión HLS→MP4, opción de solo audio, descargas asociadas a moderación, mejoras de interfaz, funciones de chat, internacionalización y utilidades del reproductor. No se debe asumir compatibilidad perfecta entre las versiones o navegadores sin probarla.

**Importantísimo:** `ROADMAP.md` incluye la instrucción explícita **«EL AGENTE NO DEBE EDITAR ESTE ARCHIVO, SÓLO LEERLO»**. Respetarla. Usar este documento, issues y PRs para gestionar el contexto general y cualquier futura planificación.

## 4. LiveMarkers: funciones y decisiones

Versión conocida: **0.1.10**. Se confirmó en pruebas reales la asociación de marcas con el VOD y la creación de marcas comunitarias; los detalles de implementación deberán verificarse contra el estado del repositorio.

- Marca manual con botón integrado al reproductor y con `Alt + M`, sin exigir permisos de moderador.
- Formulario breve de nota opcional y notificación temporal «Marcador creado».
- Registro temporal por diferencia `timestamp UTC de la marca − start_time UTC de la transmisión`, sin depender de que el contador de duración esté visible.
- Asociación de VOD mediante identificadores de Kick; respaldo **heurístico** con la fecha codificada en UUIDv7 cuando el UUID de la API difiere del de la ruta. Esto **no es una garantía oficial** de Kick ni asegura universalmente precisión de ±5 s.
- Puntos integrados en la barra nativa del reproductor; amarillos los que quedaron atrás y verdes los posteriores. En directos, los clics deben atravesarlos para que responda el control nativo; en VOD se salta al marcador.
- Panel de administración en el popup de la extensión, no en una ventana permanente de la web; sesiones, notas, calibración manual, importación/exportación y logs.
- Soporte para páginas de canal y el panel de moderación `dashboard.kick.com/moderator/<canal>`.
- Comandos de chat exactos `!mark`, `!marker`, `!marcar`, `!marcador` → nota «Solicitado por %user%»; **cooldown de 30 s global por canal dentro de una misma instalación**, sin respuestas automáticas y sin impedir marcas manuales. La detección exige que el chat esté cargado en una pestaña activa; no es un bot permanente.
- Almacenamiento local y colaboración manual mediante exportación/importación JSON. **No hay sincronización multi-equipo automática**.
- Logs de diagnóstico exportables, procurando evitar copiar tokens, URL firmadas, chats o datos innecesarios.

## 5. Integración futura — criterios de aceptación

Antes de integrar cada módulo a BetterKick, revisar:

1. **Compatibilidad:** versiones de Manifest (MV3), rutas `kick.com` y `dashboard.kick.com`, popup y service worker, compatibilidad con Chrome/Edge/Firefox cuando corresponda.
2. **Modularidad:** no añadir otra copia de los mismos observadores, listeners o llamadas a API si ya existen en la base. Separar responsabilidades, evitar colisiones de CSS y atajos.
3. **Persistencia/migraciones:** conservar marcadores, sesiones, configuraciones y datos previos de BetterKick; definir pruebas de actualización y restauración.
4. **Rendimiento:** bajo coste de CPU, memoria y red; detectar cambios del DOM de Kick sin consultas excesivas, evitar observadores duplicados.
5. **Seguridad y privacidad:** permisos mínimos, validación estricta de entradas, almacenamiento local, cero telemetría y comunicaciones funcionales exclusivamente con Kick. Conservar la privacidad de los historiales durante futuras migraciones.
6. **Licencias:** LiveMarkers se distribuye con MIT. Comprobar las licencias propias de BetterKick y de dependencias antes de combinar fuentes.
7. **Calidad:** pruebas unitarias, navegador simulado y pruebas reales de canal/VOD/dashboard, incluyendo reconexiones, cambios de canal y navegación SPA.
8. **Documentación:** README, changelog, notas de instalación, limitaciones y pruebas reproducibles, preferiblemente en español e inglés.
9. **Salida segura:** función optativa o desactivable, rollback conocido y PR separado para integración; no modificar `ROADMAP.md` automáticamente.

## 6. Colaboración con Kick

Existe intención de **ofrecer gratuitamente** mejoras y código a Kick cuando estén estabilizados, acompañados de repositorio, explicación técnica, vídeo de demostración y evidencia reproducible de pruebas reales. No se debe afirmar que Kick haya adoptado código de BetterKick ni que exista afiliación o aprobación oficial sin prueba directa.

## 7. Instrucciones para nuevas instancias de IA

Al iniciar una conversación técnica, leer **primero este archivo**, después el README/contexto del repositorio en el que se trabajará, el código y los issues/PRs recientes. Tratar este documento como orientación, no como garantía del estado actual. Separar hechos confirmados, pruebas simuladas e ideas futuras. No fusionar módulos sin solicitud explícita. Al terminar una iteración, proponer o realizar (con autorización) la actualización de los contextos afectados para que otro colaborador pueda continuar.

**Enlace permanente a este contexto:** https://github.com/TheNestorHD/BetterKick/blob/BetterKick/PROJECT_CONTEXT.md
