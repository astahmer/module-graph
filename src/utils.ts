export const isBareModuleSpecifier = (specifier: string): boolean => {
  const firstCharacter = specifier.replace(/'/g, "")[0];
  return /[@a-zA-Z]/.test(firstCharacter ?? "");
};

export const isScopedPackage = (specifier: string): boolean => specifier.startsWith("@");

export const toUnix = (value: string): string => value.replace(/\\/g, "/");

export function extractPackageNameFromSpecifier(specifier: string): string {
  const normalizedSpecifier = toUnix(specifier);

  if (isScopedPackage(normalizedSpecifier)) {
    const [scope, name] = normalizedSpecifier.split("/");
    return `${scope}/${name}`;
  }

  return normalizedSpecifier.split("/")[0] ?? "";
}
