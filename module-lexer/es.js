import { init, parse } from "es-module-lexer";

/** @type {import('../types.js').ModuleLexer} */
export const esLexer = {
    parseAsync: async ({ input }) => {
        await init;
        return {
            output: input.map(({ filename, code }) => {
                const [imports, _, facade, hasModuleSyntax] = parse(code);
                return ({
                    filename,
                    imports: imports,
                    facade,
                    hasModuleSyntax
                });
            })
        }
    }
}
