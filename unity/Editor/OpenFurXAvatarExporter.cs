// OpenFurX avatar exporter for the Unity Editor.
//
// Saves the selected avatar root as a standalone avatar-only .prefab, an optional .unitypackage with
// every dependency (meshes, materials, shaders, textures, animators, expression menus), the textures
// the materials use, an optional preview FBX, and openfurx.json describing PhysBones, inactive
// objects, clothes and the expression menu for the OpenFurX website.
//
// VRChat SDK and FBX Exporter types are read through reflection, so this script compiles in any
// project; missing pieces are skipped with a console note.
#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace OpenFurX.Editor
{
    public class OpenFurXAvatarExporter : EditorWindow
    {
        [SerializeField] private GameObject avatarRoot;
        [SerializeField] private List<GameObject> clothes = new List<GameObject>();
        [SerializeField] private bool exportPackage = true;
        [SerializeField] private bool exportFbx = true;
        [SerializeField] private bool copyTextures = true;

        private SerializedObject serialized;
        private Vector2 scroll;

        private static readonly string[] ClothKeywords =
        {
            "shirt", "pant", "jacket", "hoodie", "shoe", "boot", "sock", "glove", "hat", "cap", "beanie", "skirt", "dress",
            "cloth", "outfit", "harness", "collar", "jean", "short", "underwear", "accessor", "glass", "necklace", "bracelet",
            "choker", "belt", "vest", "coat", "sweater", "sleeve", "legging", "stocking", "bandana", "headphone", "top",
        };

        private static readonly string[] TextureExtensions = { ".png", ".jpg", ".jpeg", ".tga", ".webp" };

        [MenuItem("Tools/OpenFurX/Export Avatar Root")]
        private static void Open()
        {
            var window = GetWindow<OpenFurXAvatarExporter>("OpenFurX Export");
            if (Selection.activeGameObject != null) window.SetAvatar(Selection.activeGameObject.transform.root.gameObject);
        }

        [MenuItem("GameObject/OpenFurX/Export Avatar Root", false, 49)]
        private static void OpenFromHierarchy() => Open();

        private void OnEnable() => serialized = new SerializedObject(this);

        private void SetAvatar(GameObject go)
        {
            avatarRoot = go;
            clothes.Clear();
            AutoFillClothes();
            serialized?.Update();
        }

        private void OnGUI()
        {
            serialized.Update();
            scroll = EditorGUILayout.BeginScrollView(scroll);

            EditorGUILayout.LabelField("OpenFurX Avatar Export", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            var picked = (GameObject)EditorGUILayout.ObjectField("Avatar root", avatarRoot, typeof(GameObject), true);
            if (EditorGUI.EndChangeCheck()) SetAvatar(picked);

            if (avatarRoot != null)
            {
                var descriptor = FindComponent(avatarRoot, "VRCAvatarDescriptor");
                if (avatarRoot.transform.parent != null)
                    EditorGUILayout.HelpBox("This object is not a scene root. Avatar root prefabs are normally the top-level object.", MessageType.Warning);
                if (descriptor == null && avatarRoot.GetComponent<Animator>() == null)
                    EditorGUILayout.HelpBox("No VRC Avatar Descriptor or Animator found: this does not look like an avatar root.", MessageType.Error);
                else if (descriptor == null)
                    EditorGUILayout.HelpBox("No VRC Avatar Descriptor: exporting as a generic humanoid avatar (no expression menu).", MessageType.Info);

                int physBones = avatarRoot.GetComponentsInChildren<Component>(true).Count(c => c != null && c.GetType().Name == "VRCPhysBone");
                int inactive = avatarRoot.GetComponentsInChildren<Transform>(true).Count(t => !t.gameObject.activeSelf);
                EditorGUILayout.LabelField("PhysBones", physBones.ToString());
                EditorGUILayout.LabelField("Inactive objects", inactive.ToString());
            }

            EditorGUILayout.Space();
            EditorGUILayout.PropertyField(serialized.FindProperty(nameof(clothes)), new GUIContent("Clothing objects"), true);
            if (GUILayout.Button("Auto-fill clothes from names")) AutoFillClothes();

            EditorGUILayout.Space();
            exportPackage = EditorGUILayout.Toggle(new GUIContent("Export .unitypackage", "Prefab plus every dependency, so it imports into another project"), exportPackage);
            exportFbx = EditorGUILayout.Toggle(new GUIContent("Export preview FBX", "Needs the com.unity.formats.fbx package"), exportFbx);
            copyTextures = EditorGUILayout.Toggle(new GUIContent("Copy textures", "Copies material textures next to the FBX for the web preview"), copyTextures);

            EditorGUILayout.Space();
            using (new EditorGUI.DisabledScope(avatarRoot == null))
            {
                if (GUILayout.Button("Export Avatar Root", GUILayout.Height(32))) Export();
            }

            EditorGUILayout.EndScrollView();
            serialized.ApplyModifiedProperties();
        }

        private void AutoFillClothes()
        {
            if (avatarRoot == null) return;
            foreach (var renderer in avatarRoot.GetComponentsInChildren<Renderer>(true))
            {
                var name = renderer.gameObject.name.ToLowerInvariant();
                if (renderer.gameObject != avatarRoot && ClothKeywords.Any(k => name.Contains(k)) && !clothes.Contains(renderer.gameObject))
                    clothes.Add(renderer.gameObject);
            }
        }

        // ------------------------------------------------------------ export

        private void Export()
        {
            var name = SafeName(avatarRoot.name);
            var outDir = EditorUtility.SaveFolderPanel("Export OpenFurX avatar to folder", EditorPrefs.GetString("OpenFurX.LastDir", ""), name);
            if (string.IsNullOrEmpty(outDir)) return;
            EditorPrefs.SetString("OpenFurX.LastDir", outDir);

            try
            {
                EditorUtility.DisplayProgressBar("OpenFurX", "Saving avatar root prefab", 0.1f);
                var assetDir = $"Assets/OpenFurX/Exports/{name}";
                Directory.CreateDirectory(assetDir);
                var prefabPath = $"{assetDir}/{name}.prefab";
                SaveAvatarPrefab(prefabPath);
                File.Copy(prefabPath, Path.Combine(outDir, name + ".prefab"), true);

                if (exportPackage)
                {
                    EditorUtility.DisplayProgressBar("OpenFurX", "Exporting unitypackage", 0.35f);
                    AssetDatabase.ExportPackage(prefabPath, Path.Combine(outDir, name + ".unitypackage"),
                        ExportPackageOptions.IncludeDependencies | ExportPackageOptions.Recurse);
                }

                if (exportFbx)
                {
                    EditorUtility.DisplayProgressBar("OpenFurX", "Exporting preview FBX", 0.6f);
                    if (!TryExportFbx(avatarRoot, Path.Combine(outDir, name + ".fbx")))
                        Debug.LogWarning("[OpenFurX] FBX Exporter package not installed: export the preview model from Blender (FBX or GLB) instead.");
                }

                if (copyTextures)
                {
                    EditorUtility.DisplayProgressBar("OpenFurX", "Copying textures", 0.8f);
                    CopyTextures(outDir);
                }

                File.WriteAllText(Path.Combine(outDir, "openfurx.json"), Json.Write(BuildManifest()), new UTF8Encoding(false));
                Debug.Log($"[OpenFurX] Exported {name} to {outDir}. Upload the whole folder in the OpenFurX owner dashboard.");
                EditorUtility.RevealInFinder(Path.Combine(outDir, "openfurx.json"));
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                EditorUtility.DisplayDialog("OpenFurX export failed", ex.Message, "OK");
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }
        }

        // A detached copy keeps the scene object (and any prefab it is linked to) untouched, and
        // makes the saved asset a plain avatar root rather than a variant of the source prefab.
        private void SaveAvatarPrefab(string prefabPath)
        {
            var copy = Instantiate(avatarRoot);
            copy.name = avatarRoot.name;
            try
            {
                foreach (var t in copy.GetComponentsInChildren<Transform>(true).Where(t => t != copy.transform && t.CompareTag("EditorOnly")).ToArray())
                {
                    if (t != null) DestroyImmediate(t.gameObject);
                }
                PrefabUtility.SaveAsPrefabAsset(copy, prefabPath, out var success);
                if (!success) throw new InvalidOperationException($"Unity could not save {prefabPath}");
            }
            finally
            {
                DestroyImmediate(copy);
            }
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        private static bool TryExportFbx(GameObject root, string path)
        {
            var exporter = AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("UnityEditor.Formats.Fbx.Exporter.ModelExporter", false))
                .FirstOrDefault(t => t != null);
            var method = exporter?.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(m => m.Name == "ExportObject" && m.GetParameters().Length == 2
                                     && m.GetParameters()[0].ParameterType == typeof(string)
                                     && m.GetParameters()[1].ParameterType == typeof(UnityEngine.Object));
            if (method == null) return false;
            method.Invoke(null, new object[] { path, root });
            return File.Exists(path);
        }

        private void CopyTextures(string outDir)
        {
            var copied = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var renderer in avatarRoot.GetComponentsInChildren<Renderer>(true))
            {
                foreach (var material in renderer.sharedMaterials.Where(m => m != null))
                {
                    foreach (var property in material.GetTexturePropertyNames())
                    {
                        var texture = material.GetTexture(property);
                        var source = texture != null ? AssetDatabase.GetAssetPath(texture) : null;
                        if (string.IsNullOrEmpty(source) || !TextureExtensions.Contains(Path.GetExtension(source).ToLowerInvariant())) continue;
                        var file = Path.GetFileName(source);
                        if (copied.Add(file)) File.Copy(source, Path.Combine(outDir, file), true);
                    }
                }
            }
        }

        // ------------------------------------------------------------ manifest

        private Dictionary<string, object> BuildManifest()
        {
            var descriptor = FindComponent(avatarRoot, "VRCAvatarDescriptor");
            var physBones = new List<object>();
            foreach (var pb in avatarRoot.GetComponentsInChildren<Component>(true).Where(c => c != null && c.GetType().Name == "VRCPhysBone"))
            {
                var root = Get(pb, "rootTransform") as Transform;
                if (root == null) root = pb.transform;
                var ignore = (Get(pb, "ignoreTransforms") as IEnumerable)?.OfType<Transform>().Where(t => t != null).Select(t => (object)t.name).ToList();
                physBones.Add(new Dictionary<string, object>
                {
                    ["root"] = root.name,
                    ["name"] = pb.gameObject.name,
                    ["pull"] = GetFloat(pb, "pull", 0.2f),
                    ["spring"] = GetFloat(pb, "spring", 0.2f),
                    ["stiffness"] = GetFloat(pb, "stiffness", 0.2f),
                    ["gravity"] = GetFloat(pb, "gravity", 0f),
                    ["ignore"] = ignore ?? new List<object>(),
                });
            }

            var inactive = avatarRoot.GetComponentsInChildren<Transform>(true)
                .Where(t => t != avatarRoot.transform && !t.gameObject.activeSelf && !t.CompareTag("EditorOnly"))
                .Select(t => (object)t.name).Distinct().ToList();

            var menu = new List<object>();
            var parameters = new List<object>();
            if (descriptor != null)
            {
                var visited = new HashSet<UnityEngine.Object>();
                WriteMenu(Get(descriptor, "expressionsMenu") as UnityEngine.Object, menu, 0, visited);
                foreach (var p in (Get(Get(descriptor, "expressionParameters"), "parameters") as IEnumerable)?.Cast<object>() ?? Enumerable.Empty<object>())
                {
                    var paramName = Get(p, "name") as string;
                    if (string.IsNullOrEmpty(paramName)) continue;
                    var valueType = Get(p, "valueType")?.ToString() ?? "Float";
                    parameters.Add(new Dictionary<string, object>
                    {
                        ["name"] = paramName,
                        ["type"] = valueType == "Bool" || valueType == "Int" ? valueType : "Float",
                        ["defaultValue"] = GetFloat(p, "defaultValue", 0f),
                    });
                }
            }

            return new Dictionary<string, object>
            {
                ["format"] = "openfurx-avatar",
                ["version"] = 1,
                ["name"] = avatarRoot.name,
                ["unity"] = Application.unityVersion,
                ["rig"] = new Dictionary<string, object>
                {
                    ["source"] = descriptor != null ? "vrchat" : "unity",
                    ["physbones"] = physBones,
                    ["inactive"] = inactive,
                    ["clothes"] = clothes.Where(c => c != null).Select(c => (object)c.name).Distinct().ToList(),
                    ["expressions"] = new Dictionary<string, object> { ["menu"] = menu, ["parameters"] = parameters },
                },
            };
        }

        private static readonly Dictionary<string, string> ControlTypes = new Dictionary<string, string>
        {
            ["Button"] = "button", ["Toggle"] = "toggle", ["SubMenu"] = "submenu",
            ["TwoAxisPuppet"] = "twoaxis", ["FourAxisPuppet"] = "fouraxis", ["RadialPuppet"] = "radial",
        };

        private static void WriteMenu(UnityEngine.Object menu, List<object> output, int depth, HashSet<UnityEngine.Object> visited)
        {
            if (menu == null || depth > 6 || !visited.Add(menu)) return;
            foreach (var control in (Get(menu, "controls") as IEnumerable)?.Cast<object>() ?? Enumerable.Empty<object>())
            {
                var typeName = Get(control, "type")?.ToString() ?? "Toggle";
                var type = ControlTypes.TryGetValue(typeName, out var mapped) ? mapped : "toggle";
                var parameter = Get(Get(control, "parameter"), "name") as string;
                if (type == "radial" && Get(control, "subParameters") is IList subs && subs.Count > 0)
                    parameter = Get(subs[0], "name") as string ?? parameter;

                var entry = new Dictionary<string, object>
                {
                    ["name"] = Get(control, "name") as string ?? "Control",
                    ["type"] = type,
                    ["parameter"] = parameter ?? "",
                    ["value"] = GetFloat(control, "value", 1f),
                    ["targets"] = new List<object>(),
                };
                if (type == "submenu")
                {
                    var children = new List<object>();
                    WriteMenu(Get(control, "subMenu") as UnityEngine.Object, children, depth + 1, visited);
                    entry["controls"] = children;
                }
                output.Add(entry);
            }
            visited.Remove(menu); // the same submenu may legitimately appear in two branches
        }

        // ------------------------------------------------------------ helpers

        private static Component FindComponent(GameObject go, string typeName) =>
            go.GetComponents<Component>().FirstOrDefault(c => c != null && c.GetType().Name == typeName);

        private static object Get(object target, string member)
        {
            if (target == null) return null;
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            var type = target.GetType();
            var field = type.GetField(member, flags);
            if (field != null) return field.GetValue(target);
            var property = type.GetProperty(member, flags);
            return property != null && property.GetIndexParameters().Length == 0 ? property.GetValue(target) : null;
        }

        private static float GetFloat(object target, string member, float fallback)
        {
            var value = Get(target, member);
            return value is float f ? f : value is int i ? i : fallback;
        }

        private static string SafeName(string name)
        {
            var clean = new string(name.Select(ch => char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' ? ch : '_').ToArray()).Trim('_');
            return string.IsNullOrEmpty(clean) ? "Avatar" : clean;
        }

        // Minimal JSON writer so the script has no package dependencies.
        private static class Json
        {
            public static string Write(object value)
            {
                var sb = new StringBuilder();
                WriteValue(sb, value, 0);
                return sb.ToString();
            }

            private static void WriteValue(StringBuilder sb, object value, int indent)
            {
                switch (value)
                {
                    case null: sb.Append("null"); break;
                    case string s: WriteString(sb, s); break;
                    case bool b: sb.Append(b ? "true" : "false"); break;
                    case float f: sb.Append(!float.IsNaN(f) && !float.IsInfinity(f) ? f.ToString("0.####", CultureInfo.InvariantCulture) : "0"); break;
                    case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); break;
                    case IDictionary<string, object> dict:
                        sb.Append('{');
                        var first = true;
                        foreach (var pair in dict)
                        {
                            sb.Append(first ? "\n" : ",\n").Append(' ', (indent + 1) * 2);
                            WriteString(sb, pair.Key);
                            sb.Append(": ");
                            WriteValue(sb, pair.Value, indent + 1);
                            first = false;
                        }
                        if (!first) sb.Append('\n').Append(' ', indent * 2);
                        sb.Append('}');
                        break;
                    case IEnumerable list:
                        sb.Append('[');
                        var any = false;
                        foreach (var item in list)
                        {
                            sb.Append(any ? ",\n" : "\n").Append(' ', (indent + 1) * 2);
                            WriteValue(sb, item, indent + 1);
                            any = true;
                        }
                        if (any) sb.Append('\n').Append(' ', indent * 2);
                        sb.Append(']');
                        break;
                    default: WriteString(sb, value.ToString()); break;
                }
            }

            private static void WriteString(StringBuilder sb, string s)
            {
                sb.Append('"');
                foreach (var ch in s)
                {
                    switch (ch)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                            else sb.Append(ch);
                            break;
                    }
                }
                sb.Append('"');
            }
        }
    }
}
#endif
