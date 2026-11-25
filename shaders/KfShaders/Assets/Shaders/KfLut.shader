// Grading (baked by the bridge) and LUT files: two 3D colour tables (.cube / PNG), each with a strength and "everything / light only / colour only",
// one after the other (chain) or mixed.
Shader "Hidden/KeyframeStudio/Lut"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _KfLutA ("", 3D) = "" {}
        _KfLutB ("", 3D) = "" {}
        _KfLutG ("", 3D) = "" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            sampler3D _KfLutA;
            sampler3D _KfLutB;
            sampler3D _KfLutG;   // Grading (curves, colour by colour, split toning…) baked by the bridge
            float4 _KfLutGInfo;  // x size, w on
            float4 _KfLutAInfo; // x size, y amount (0..1), z mode (0 everything, 1 light only, 2 colour only), w on
            float4 _KfLutBInfo; // the same for the second table
            float _KfLutCombine; // 0 chain (B after A), 1 mix (B's amount mixes A and B)

            float3 Look(sampler3D t, float n, float3 c)
            {
                float3 uvw = saturate(c) * ((n - 1) / n) + 0.5 / n;
                return tex3D(t, uvw).rgb;
            }

            float3 Use(float3 c, float3 l, float mode)
            {
                if (mode > 1.5) return l + (Luma(c) - Luma(l)); // the table's colour, the picture's lightness
                if (mode > 0.5) return c + (Luma(l) - Luma(c)); // the table's lightness, the picture's colour
                return l;
            }

            // LUT files are made for gamma-encoded colour (what a picture file holds); Studio's camera may work in linear
            // (set from the game's colour space at run time: this bundle's own project setting says nothing about the game)
            float _KfLinear;
            float3 ToFile(float3 c) { return _KfLinear > 0.5 ? LinearToGammaSpace(saturate(c)) : c; }
            float3 FromFile(float3 c) { return _KfLinear > 0.5 ? GammaToLinearSpace(saturate(c)) : saturate(c); }

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 src = tex2D(_MainTex, i.uv);
                float3 c = ToFile(src.rgb);
                if (_KfLutGInfo.w > 0.5) c = Look(_KfLutG, _KfLutGInfo.x, c);
                float3 a = c;
                if (_KfLutAInfo.w > 0.5) a = lerp(c, Use(c, Look(_KfLutA, _KfLutAInfo.x, c), _KfLutAInfo.z), _KfLutAInfo.y);
                if (_KfLutBInfo.w < 0.5) return fixed4(FromFile(a), src.a);
                if (_KfLutCombine < 0.5)
                {
                    float3 o = lerp(a, Use(a, Look(_KfLutB, _KfLutBInfo.x, a), _KfLutBInfo.z), _KfLutBInfo.y);
                    return fixed4(FromFile(o), src.a);
                }
                float3 b = Use(c, Look(_KfLutB, _KfLutBInfo.x, c), _KfLutBInfo.z);
                return fixed4(FromFile(lerp(a, b, _KfLutBInfo.y)), src.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
