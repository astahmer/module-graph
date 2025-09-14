import rsModuleLexer from 'rs-module-lexer';

const { parseAsync } = rsModuleLexer;

/** @type {import('../types.js').ModuleLexer} */
export const rsLexer = {
    parseAsync: ({ input }) => parseAsync({ input }).then(({ output }) => ({
        output: output.map(({ filename, imports, facade, hasModuleSyntax }) => ({
            filename,
            imports: imports,
            facade,
            hasModuleSyntax
        }))
    }))
}
