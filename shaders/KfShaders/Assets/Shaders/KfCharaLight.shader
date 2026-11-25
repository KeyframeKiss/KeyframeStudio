// Character lights, step 3 (on the finished picture): every scene light switched to light characters (up to 8:
// point, spot, directional) added where a character is the nearest thing, from the surface direction, distance and
// colour of steps 1 and 2 — soft like a regular light, or with a toon edge. Works whatever shader the character uses.
Shader "Hidden/KeyframeStudio/CharaLight"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _KfCharaGeo ("", 2D) = "black" {}
        _KfCharaAlbedo ("", 2D) = "white" {}
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

            sampler2D_float _CameraDepthTexture;
            sampler2D _KfCharaGeo;
            sampler2D _KfCharaAlbedo;
            float4x4 _KfInvProj;
            float4x4 _KfCamToWorld;
            float4 _KfLPos[8];   // xyz position, w type (0 point, 1 spot, 2 directional)
            float4 _KfLDir[8];   // xyz direction it shines, w cos of the cone's edge (spot)
            float4 _KfLCol[8];   // rgb colour × intensity, w range (m)
            float4 _KfCharaLight; // x number of lights, y strength, z toon (0/1), w toon edge softness

            float4 frag(v2f i) : SV_Target
            {
                float4 src = tex2D(_MainTex, i.uv);
                float4 g = tex2D(_KfCharaGeo, i.uv);
                if (g.a <= 0.0001) return src; // no character here
                // only where the view shows that very surface: not through a wall or prop in front, and not on
                // what shows through gaps in hair cards or lace (the view's depth skips those, ours doesn't)
                float scene = LinearEyeDepth(SAMPLE_DEPTH_TEXTURE(_CameraDepthTexture, i.uvDepth));
                if (abs(scene - g.a) > g.a * 0.006 + 0.006) return src;
                float4 ray = mul(_KfInvProj, float4(i.uv * 2 - 1, 1, 1));
                float3 vpos = ray.xyz / ray.w;
                vpos *= g.a / max(1e-5, -vpos.z);
                float3 wp = mul(_KfCamToWorld, float4(vpos, 1)).xyz;
                float3 n = normalize(g.xyz);
                float3 alb = tex2D(_KfCharaAlbedo, i.uv).rgb;
                float3 sum = 0;
                int count = (int)_KfCharaLight.x;
                for (int k = 0; k < 8; k++)
                {
                    if (k >= count) break;
                    float4 P = _KfLPos[k], D = _KfLDir[k], C = _KfLCol[k];
                    float3 L;
                    float att = 1;
                    if (P.w > 1.5) L = -D.xyz;
                    else
                    {
                        float3 v = P.xyz - wp;
                        float d = length(v);
                        L = v / max(d, 1e-4);
                        float x = saturate(d / max(C.w, 1e-3));
                        att = (1 - x * x) * (1 - x * x) / (1 + 25 * x * x); // about as the game's own lights fall off, smoothly nothing at its range
                        if (P.w > 0.5) att *= smoothstep(D.w, lerp(D.w, 1, 0.25), dot(-L, D.xyz));
                    }
                    float ndl = dot(n, L);
                    float term = _KfCharaLight.z > 0.5
                        ? smoothstep(-_KfCharaLight.w, _KfCharaLight.w, ndl)   // toon: a clean edge
                        : saturate((ndl + 0.25) / 1.25);                    // soft, a little wrap like skin
                    sum += C.rgb * att * term;
                }
                float3 add = alb * sum * _KfCharaLight.y;
                // line art (outlines, drawn lines) is far darker than the colour under it: it stays as drawn
                float ratio = dot(src.rgb, float3(0.2126, 0.7152, 0.0722)) / max(1e-3, dot(alb, float3(0.2126, 0.7152, 0.0722)));
                add *= smoothstep(0.05, 0.3, ratio);
                // added like light on film: bright parts keep their detail instead of clipping to white
                return float4(src.rgb + add * saturate(1 - src.rgb), src.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
